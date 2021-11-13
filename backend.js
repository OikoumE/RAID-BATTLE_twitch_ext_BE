/**
 *    Copyright 2018 Amazon.com, Inc. or its affiliates
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *
 *        http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 */

const fs = require("fs");
const Hapi = require("hapi");
const path = require("path");
const Boom = require("boom");
const ext = require("commander");
const jsonwebtoken = require("jsonwebtoken");
const request = require("request");

// The developer rig uses self-signed certificates.  Node doesn't accept them
// by default.  Do not use this in production.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// Use verbose logging during development.  Set this to false for production.
const verboseLogging = true;
const verboseLog = verboseLogging ? console.log.bind(console) : () => {};

// Service state variables
const serverTokenDurationSec = 30; // our tokens for pubsub expire after 30 seconds
const userCooldownMs = 100; // maximum input rate per user to prevent bot abuse
const userCooldownClearIntervalMs = 60000; // interval to reset our tracking object
const channelCooldownMs = 1000; // maximum broadcast rate per channel
const bearerPrefix = "Bearer "; // HTTP authorization headers have this prefix
const channelCooldowns = {}; // rate limit compliance
let userCooldowns = {}; // spam prevention
const { resolveObjectURL } = require("buffer");
const { get } = require("https");

//! --------------------------------------------------------- //
//*                      -- TODO's --                        //
//! ------------------------------------------------------- //
// TODO Make a logger that logs critical errors to DB
// TODO log pr channelID: timestamp, error, scriptLocation

//! --------------------------------------------------------- //
//*                      -- MY VARS --                       //
//! ------------------------------------------------------- //
const tmi = require("tmi.js");
const fetch = require("node-fetch");
const { MongoClient } = require("mongodb");
const mongoUri = process.env.MONGODB_URL;

//* twitch api auth
const APP_CLIENT_ID =
        process.env.APP_CLIENT_ID || "cr20njfkgll4okyrhag7xxph270sqk", //! CHANGE WITH OWN EXT SPECIFIC APP CLIENT ID!
    APP_CLIENT_SECRET = process.env.APP_CLIENT_SECRET || "";
let APP_ACCESS_TOKEN = null,
    TOKEN_EXPIRE_DATE = null;

const initialHealth = 100,
    channelRaiders = {},
    KEEP_HEROKU_ALIVE_INTERVAL = 5;
var dataBase, tmiClient;
//! -------------------- my vars -------------------- //

function printTimeout() {
    var date = new Date();
    console.log(`ALIVE CHECKER: ${date.toDateString()} ${date.toTimeString()}`);
    setTimeout(() => {
        printTimeout();
    }, KEEP_HEROKU_ALIVE_INTERVAL * 60 * 1000);
}
printTimeout();

const STRINGS = {
    secretEnv: usingValue("secret"),
    clientIdEnv: usingValue("client-id"),
    ownerIdEnv: usingValue("owner-id"),
    serverStarted: "Server running at %s",
    secretMissing: missingValue("secret", "EXT_SECRET"),
    clientIdMissing: missingValue("client ID", "EXT_CLIENT_ID"),
    ownerIdMissing: missingValue("owner ID", "EXT_OWNER_ID"),
    messageSendError: "Error sending message to channel %s: %s",
    pubsubResponse: "Broadcast to c:%s returned %s",
    cooldown: "Please wait before clicking again",
    invalidAuthHeader: "Invalid authorization header",
    invalidJwt: "Invalid JWT",
};

ext.version(require("./package.json").version)
    .option("-s, --secret <secret>", "Extension secret")
    .option("-c, --client-id <client_id>", "Extension client ID")
    .option("-o, --owner-id <owner_id>", "Extension owner ID")
    .parse(process.argv);

const ownerId = getOption("ownerId", "EXT_OWNER_ID");
const secret = Buffer.from(getOption("secret", "EXT_SECRET"), "base64");
const clientId = getOption("clientId", "EXT_CLIENT_ID");

const serverOptions = {
    host: "0.0.0.0",
    port: process.env.PORT || 8081,
    routes: {
        cors: {
            origin: ["*"],
        },
    },
};
const serverPathRoot = path.resolve(__dirname, "..", "conf", "server");
if (
    fs.existsSync(serverPathRoot + ".crt") &&
    fs.existsSync(serverPathRoot + ".key")
) {
    serverOptions.tls = {
        // If you need a certificate, execute "npm run cert".
        cert: fs.readFileSync(serverPathRoot + ".crt"),
        key: fs.readFileSync(serverPathRoot + ".key"),
    };
}
const server = new Hapi.Server(serverOptions);
//! --------------------------------------------------------- //
//*                     -- ON LAUNCH --                      //
//! ------------------------------------------------------- //
async function onLaunch() {
    dataBase = new DataBase(mongoUri);
    await dataBase.connect();
    //this is ran when server starts up
    console.log("[backend:130]: Server starting");
    // const data = readJsonFile(streamersFilePath); //! REDO TO DB
    // channelsToJoin = data.channels; //! REDO TO DB
    // channelIds = data.channelIds; //! REDO TO DB
    const dataBaseData = await dataBase.find();
    const result = parseTmiChannelListFromDb(dataBaseData);
    startTmi(result);
}

(async () => {
    // Handle broadcasting a testraid
    server.route({
        method: "POST",
        path: "/TESTRAID/{raider?}",
        handler: startTestRaid, //
    });
    // Handle adding new streamers to channels to watch for raids
    server.route({
        method: "POST",
        path: "/addStreamerToChannels/",
        handler: addStreamerToChannelsHandler, //
    });
    // Handle a viewer request to support the raider.
    server.route({
        method: "POST",
        path: "/heal/{raider?}",
        handler: raiderSupportHandler, //
    });
    // Handle a viewer request to support the streamer.
    server.route({
        method: "POST",
        path: "/damage/",
        handler: streamerSupportHandler, //
    });
    server.route({
        method: "GET",
        path: "/ongoingRaidGame/",
        handler: ongoingRaidGameQueryHandler,
    });
    server.route({
        method: "GET",
        path: "/",
        handler: return404,
    });
    // Start the server.
    await server.start();
    console.log(`[backend:174]: ${STRINGS.serverStarted}${server.info.uri}`);
    // Periodically clear cool-down tracking to prevent unbounded growth due to
    // per-session logged-out user tokens.
    setInterval(() => {
        userCooldowns = {};
    }, userCooldownClearIntervalMs);
    onLaunch();
})();

function return404(req) {
    return "<style> html { background-color: #000000;} </style><img src='https://http.cat/404.jpg' />";
}

function usingValue(name) {
    return `Using environment variable for ${name}`;
}

function missingValue(name, variable) {
    const option = name.charAt(0);
    return `Extension ${name} required.\nUse argument "-${option} <${name}>" or environment variable "${variable}".`;
}

// Get options from the command line or the environment.
function getOption(optionName, environmentName) {
    const option = (() => {
        if (ext[optionName]) {
            return ext[optionName];
        } else if (process.env[environmentName]) {
            console.log(STRINGS[optionName + "Env"]);
            return process.env[environmentName];
        }
        console.log(STRINGS[optionName + "Missing"]);
        process.exit(1);
    })();
    console.log(`Using "${option}" for ${optionName}`);
    return option;
}

// Verify the header and the enclosed JWT.
function verifyAndDecode(header) {
    if (header.startsWith(bearerPrefix)) {
        try {
            const token = header.substring(bearerPrefix.length);
            return jsonwebtoken.verify(token, secret, {
                algorithms: ["HS256"],
            });
        } catch (ex) {
            throw Boom.unauthorized(STRINGS.invalidJwt);
        }
    }
    throw Boom.unauthorized(STRINGS.invalidAuthHeader);
}
// ! -------------------- SERVER STUFF -------------------- //
// Create and return a JWT for use by this service.
function makeServerToken(channelId) {
    const payload = {
        exp: Math.floor(Date.now() / 1000) + serverTokenDurationSec,
        channel_id: channelId,
        user_id: ownerId, // extension owner ID for the call to Twitch PubSub
        role: "external",
        pubsub_perms: {
            send: ["*"],
        },
    };
    return jsonwebtoken.sign(payload, secret, { algorithm: "HS256" });
}

function userIsInCooldown(opaqueUserId) {
    // Check if the user is in cool-down.
    const cooldown = userCooldowns[opaqueUserId];
    const now = Date.now();
    if (cooldown && cooldown > now) {
        return true;
    }
    // Voting extensions must also track per-user votes to prevent skew.
    userCooldowns[opaqueUserId] = now + userCooldownMs;
    return false;
}

//! --------------------------------------------------------- //
//*                       -- DATABASE --                     //
//! ------------------------------------------------------- //
class DataBase {
    constructor(mongoUri) {
        console.log(
            "[backend:266]: attempting connection to mongoUri",
            mongoUri
        );
        this.client = new MongoClient(mongoUri, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        this.dataBaseName = "RaidBattle";
        this.collection = "users";
    }
    async connect() {
        try {
            await this.client.connect();
        } catch (e) {
            console.log("[backend:276]: e", e);
        }
    }
    async insertOne(document, collection = this.collection) {
        const result = await this.client
            .db(this.dataBaseName)
            .collection(collection)
            .insertOne(document);
        if (result) {
            console.log(
                `[backend:287]: new db entry added at`,
                result.insertedId
            );
            return result;
        }
        console.log(`[backend:293]: no documents added:`, result);
    }
    async findOne(document, collection = this.collection) {
        const result = await this.client
            .db(this.dataBaseName)
            .collection(collection)
            .findOne(document);
        if (result) {
            return result;
        }
        console.log(
            `[backend:301]: no document found with document:`,
            document
        );
    }
    async find(collection = this.collection) {
        const result = await this.client
            .db(this.dataBaseName)
            .collection(collection)
            .find()
            .toArray();
        if (result) {
            return result;
        }
        console.log(`[backend:301]: no documents found:`, result);
    }
    async checkIfUserInDb(channelId) {
        const result = await this.find();
        for (const document of result) {
            if (document.channelId == channelId) {
                return true;
            }
        }
        return false;
    }
    //TODO deleteOne //? idk if we need
}
//! -------------------- DATABASE HANDLERS -------------------- //
async function addNewStreamer(channelId) {
    const userExsist = await dataBase.checkIfUserInDb(channelId);
    if (!userExsist) {
        const userData = await getUser(`id=${channelId}`);
        const result = await addStreamerToDb(userData);
        console.log("[backend:337]: result", result);
        const allChannelList = await dataBase.find();
        const newChannelList = parseTmiChannelListFromDb(allChannelList);
        console.log("[backend:446]: newChannelList", newChannelList);
        restartTmi(newChannelList);
        return "Success, added to channels to monitor for raids";
    } else {
        return "Already in the list of channels to monitor for raid";
    }
}

async function addStreamerToDb(userData) {
    const result = await dataBase.insertOne({
        channelName: userData.display_name.toLowerCase(),
        displayName: userData.display_name,
        channelId: userData._id,
        profilePicUrl: userData.logo,
    });
    return result;
}
function parseTmiChannelListFromDb(result) {
    const channels = [];
    for (const document of result) {
        channels.push(document.channelName);
    }
    console.log("[backend:317]: channels", channels);
    return channels;
}

//! --------------------------------------------------------- //
//*                   -- ROUTE HANDLERS --                   //
//! ------------------------------------------------------- //
async function ongoingRaidGameQueryHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    const result = await dataBase.findOne({ channelId });
    if (!result) {
        addNewStreamer(channelId);
    }
    if (
        !Array.isArray(channelRaiders[channelId]) //|| channelRaiders[channelId].length == 0
    ) {
        console.log("[backend:321]: No active games");
        return null;
    }
    return channelRaiders[channelId];
}

function addStreamerToChannelsHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    return addNewStreamer(channelId);
}

function raiderSupportHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    const raider = req.params.raider;
    // Bot abuse prevention:  don't allow a user to spam the button.
    if (userIsInCooldown(opaqueUserId)) {
        throw Boom.tooManyRequests(STRINGS.cooldown);
    }
    verboseLog(
        `increase health on raider: ${raider} in stream: ${channelId}, by ${opaqueUserId}`
    );
    // increase health on specific raider
    for (const raiderObj of channelRaiders[channelId]) {
        if (raiderObj.raider == raider && raiderObj.health < 100) {
            raiderObj.health = raiderObj.health + raiderObj.supportRatio.raider;
            console.log(
                "[backend:332]: raiderObj.supportRatio.raider",
                raiderObj.supportRatio.raider
            );
        }
    }
    // Broadcast the health change to all other extension instances on this channel.
    attemptHealthBroadcast(channelId, raider);
    return JSON.stringify(channelRaiders[channelId]);
}
function streamerSupportHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    // Bot abuse prevention:  don't allow a user to spam the button.
    if (userIsInCooldown(opaqueUserId)) {
        throw Boom.tooManyRequests(STRINGS.cooldown);
    }
    for (const raiderObj of channelRaiders[channelId]) {
        if (raiderObj.health >= 1) {
            raiderObj.health =
                raiderObj.health - raiderObj.supportRatio.streamer;
            console.log(
                "[backend:350]: raiderObj.supportRatio.streamer",
                raiderObj.supportRatio.streamer
            );
        } else {
            //TODO RETURN DEAFETED RAIDER STATE!
        }
    }
    verboseLog(
        `reduce health on all raiders in stream: ${channelId}, by ${opaqueUserId}`
    );
    // Broadcast the health change to all other extension instances on this channel.
    attemptHealthBroadcast(channelId);
    return JSON.stringify(channelRaiders[channelId]);
}

//! -------------------- SEND BROADCAST TO EXT -------------------- //
function attemptHealthBroadcast(channelId) {
    // Check the cool-down to determine if it's okay to send now.
    const now = Date.now();
    const cooldown = channelCooldowns[channelId];
    if (!cooldown || cooldown.time < now) {
        // It is.
        sendHealthBroadcast(channelId);
        channelCooldowns[channelId] = { time: now + channelCooldownMs };
    } else if (!cooldown.trigger) {
        // It isn't; schedule a delayed broadcast if we haven't already done so.
        cooldown.trigger = setTimeout(
            sendHealthBroadcast,
            now - cooldown.time,
            channelId
        );
    }
}

function sendHealthBroadcast(channelId) {
    // Set the HTTP headers required by the Twitch API.
    const headers = {
        "Client-ID": clientId,
        "Content-Type": "application/json",
        Authorization: bearerPrefix + makeServerToken(channelId),
    };
    // Create the POST body for the Twitch API request.
    const body = JSON.stringify({
        content_type: "application/json",
        message: JSON.stringify(channelRaiders[channelId]),
        targets: ["broadcast"],
    });
    // Send the broadcast request to the Twitch API.
    verboseLog(
        `broadcasting channelRaidersArray: ${channelRaiders[channelId]}, for ${channelId}`
    );
    request(
        `https://api.twitch.tv/extensions/message/${channelId}`,
        {
            method: "POST",
            headers,
            body,
        },
        (err, res) => {
            if (err) {
                console.error(
                    "[backend:460]: STRINGS.messageSendError, channelId, err",
                    STRINGS.messageSendError,
                    channelId,
                    err
                );
            } else {
                verboseLog(STRINGS.pubsubResponse, channelId, res.statusCode);
            }
        }
    );
}

function attemptRaidBroadcast(channelId) {
    // Check the cool-down to determine if it's okay to send now.
    const now = Date.now();
    const cooldown = channelCooldowns[channelId];
    if (!cooldown || cooldown.time < now) {
        // It is.
        sendRaidBroadcast(channelId);
        channelCooldowns[channelId] = { time: now + channelCooldownMs };
    } else if (!cooldown.trigger) {
        // It isn't; schedule a delayed broadcast if we haven't already done so.
        cooldown.trigger = setTimeout(
            sendRaidBroadcast,
            now - cooldown.time,
            channelId
        );
    }
}
function sendRaidBroadcast(channelId) {
    // Set the HTTP headers required by the Twitch API.
    const headers = {
        "Client-ID": clientId,
        "Content-Type": "application/json",
        Authorization: bearerPrefix + makeServerToken(channelId),
    };
    // Create the POST body for the Twitch API request.
    const body = JSON.stringify({
        content_type: "application/json",
        message: JSON.stringify(channelRaiders[channelId]),
        targets: ["broadcast"],
    });
    // Send the broadcast request to the Twitch API.
    // verboseLog(`broadcasting health: ${currentHealth}, for ${channelId}`);
    request(
        `https://api.twitch.tv/extensions/message/${channelId}`,
        {
            method: "POST",
            headers,
            body,
        },
        (err, res) => {
            if (err) {
                console.log(STRINGS.messageSendError, channelId, err);
            } else {
                verboseLog(STRINGS.pubsubResponse, channelId, res.statusCode);
            }
        }
    );
}
function broadcastTimeleft() {
    // TODO reset health after X time
    // TODO end game state
    // TODO when all raiders are dead
    // TODO timer, add to timer if new raid during game (part of class)
    // TODO sending gameOverState: win/defeated raiderX/loose
    // TODO a class/func
    // TODO timerthingy
    // TODO broadcast 1sec interval
    // TODO PLACEHOLDER
    // TODO PLACEHOLDER
    // TODO start counting down when game start
    // TODO attempt broadcast every second with updated TIMELEFT if game is still running
    // TODO when game end send final broadcast to end game on frontend and clean up
    // TODO setInterval broadcast every sec for timer update!
    //? maybe override broadcastHealth with a setinterval broadcast?
    setTimeout(() => {
        let gameIsRunning, TIMELEFT;
        if (gameIsRunning) {
            broadcastTimeleft();
            attemptHealthBroadcast("123");
        } else if (!gameIsRunning && TIMELEFT == 0) {
            //broadcast end raid game
        }
    }, 1000);
}

//! --------------------------------------------------------- //
//*                      -- TWITCH API --                    //
//! ------------------------------------------------------- //
async function getAppAccessToken() {
    if (!APP_ACCESS_TOKEN || Date.now() >= TOKEN_EXPIRE_DATE) {
        const endpoint = `https://id.twitch.tv/oauth2/token?client_id=${APP_CLIENT_ID}&client_secret=${APP_CLIENT_SECRET}&grant_type=client_credentials`;
        const result = await fetch(endpoint, { method: "POST" });
        if (result.ok) {
            const data = await result.json();
            console.log("[backend:588]: data", data);
            APP_ACCESS_TOKEN = data.access_token;
            process.env.APP_ACCESS_TOKEN = APP_ACCESS_TOKEN;
            TOKEN_EXPIRE_DATE = Date.now() + data.expires_in * 1000;
        }
    }
    return APP_ACCESS_TOKEN;
}

async function getUser(path) {
    // Query Twitch for user details.
    const url = "https://api.twitch.tv/helix/users?" + path,
        appToken = await getAppAccessToken(),
        headers = {
            Authorization: `Bearer ${appToken}`,
            "Client-Id": APP_CLIENT_ID,
        };
    // Handle response.
    try {
        let response = await fetch(url, { headers });
        if (response.ok) {
            let data = await response.json();
            console.log(`[backend:648]: User for path ${path} found:`, data);
            return data.data[0];
        } else {
            console.log("[backend:618]: response", response);
        }
    } catch (err) {
        console.log("[backend:674]: Error when getting user by ID", err);
    }

    // const example_data = {
    //     data: [
    //         {
    //             id: "141981764",
    //             login: "twitchdev",
    //             display_name: "TwitchDev",
    //             type: "",
    //             broadcaster_type: "partner",
    //             description:
    //                 "Supporting third-party developers building Twitch integrations from chatbots to game integrations.",
    //             profile_image_url:
    //                 "https://static-cdn.jtvnw.net/jtv_user_pictures/8a6381c7-d0c0-4576-b179-38bd5ce1d6af-profile_image-300x300.png",
    //             offline_image_url:
    //                 "https://static-cdn.jtvnw.net/jtv_user_pictures/3f13ab61-ec78-4fe6-8481-8682cb3b0ac2-channel_offline_image-1920x1080.png",
    //             view_count: 5980557,
    //             email: "not-real@email.com",
    //             created_at: "2016-12-14T20:32:28Z",
    //         },
    //     ],
    // };
}

async function getStreamById(id) {
    // Query Twitch for stream details.
    const url = `https://api.twitch.tv/helix/streams?user_id=${id}`,
        appToken = await getAppAccessToken(),
        headers = {
            Authorization: `Bearer ${appToken}`,
            "Client-Id": APP_CLIENT_ID,
        };
    // Handle response.
    try {
        let response = await fetch(url, { headers });
        if (response.ok) {
            let data = await response.json();
            console.log(`[backend:657]: StreamData for id ${id} found:`, data);
            return data.data[0];
        } else {
            console.log("[backend:593]: response", response);
        }
    } catch (err) {
        console.log("[backend:661]: Error when getting stream by ID", err);
    }
    // const example_data = {
    //     data: [
    //         {
    //             id: "40952121085",
    //             user_id: "101051819",
    //             user_login: "afro",
    //             user_name: "Afro",
    //             game_id: "32982",
    //             game_name: "Grand Theft Auto V",
    //             type: "live",
    //             title: "Jacob: Digital Den Laptops & Routers | NoPixel | !MAINGEAR !FCF",
    //             viewer_count: 1490,
    //             started_at: "2021-03-10T03:18:11Z",
    //             language: "en",
    //             thumbnail_url:
    //                 "https://static-cdn.jtvnw.net/previews-ttv/live_user_afro-{width}x{height}.jpg",
    //             tag_ids: ["6ea6bca4-4712-4ab9-a906-e3336a9d8039"],
    //             is_mature: false,
    //         },
    //     ],
    //     pagination: {},
    // };
}

function getRatio(raiders, viewers) {
    const highestNum = Math.max(raiders, viewers);
    const ratio = {
        raider: viewers / highestNum,
        streamer: raiders / highestNum,
    };
    //{ raider: 0.1, streamer: 1 }
    console.log("[backend:446]: ratio", ratio);
    return ratio;
}

//! --------------------------------------------------------- //
//*                       -- TMI.JS --                       //
//! ------------------------------------------------------- //

function startTmi(channels) {
    tmiClient = new tmi.Client({
        connection: {
            secure: true,
            reconnect: true,
        },
        channels: channels,
    });
    tmiClient.connect().then(() => {
        console.log(`[backend:529]: Listening for messages on ${channels}`);
    });
    tmiClient.on("raided", (channel, username, viewers) => {
        // channel: String - Channel name being raided
        // username: String - Username raiding the channel
        // viewers: Integer - Viewers count
        console.log(`[backend:536]: 
            ${channel} was raided by: ${username} with ${viewers} viewers`);
        channel = channel.replace("#", "");
        viewers = parseInt(viewers);
        startRaid(channel, username, viewers);
    });
}
function restartTmi(channelList) {
    if (tmiClient) {
        tmiClient.disconnect();
    } else {
        console.error("no tmi connected??");
    }
    tmiClient.on("disconnected", (reason) => {
        console.error("[backend:346]: reason", reason);
        startTmi(channelList);
    });
}
async function startRaid(channel, username, viewers) {
    console.log(
        `[backend:549]: Starting raid on channel: ${channel}, started by: ${username}`
    );
    // const channelId = channelIds[channel];
    const streamerData = await dataBase.findOne({ channelName: channel });
    const channelId = streamerData.channelId;
    // (async () => {//!
    const streamData = await getStreamById(channelId),
        currentViewers = streamData.viewer_count,
        raiderData = await getUser(`login=${username}`),
        raiderPicUrl = raiderData.profile_image_url, //.userPicUrl
        streamerPicUrl = streamerData.profilePicUrl, // HAVE IN DB
        supportRatio = getRatio(viewers, currentViewers);
    const raidPackage = {
        channel,
        raider: username,
        health: initialHealth,
        viewers,
        currentViewers,
        supportRatio,
        raiderPicUrl,
        streamerPicUrl,
    };
    if (!Array.isArray(channelRaiders[channelId])) {
        channelRaiders[channelId] = [];
    }
    if (!channelRaiders[channelId].some((item) => item.raider === username)) {
        channelRaiders[channelId].push(raidPackage);
    }
    attemptRaidBroadcast(channelId);
    // })();//!
    if (channelRaiders[channelId]) {
        return channelRaiders[channelId];
    } else {
        return null;
    }
}

//! --------------------------------------------------------- //
//*                     -- TEST AREA --                      //
//! ------------------------------------------------------- //
//! -------------------- SEND TESTRAID BROADCAST TO EXT -------------------- //
let numberOfRaiders = 0;
function startTestRaid(req) {
    //! TESTING
    // Tmi wil trigger raid internally
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization); //! NOT NEEDED AFTER TESTING
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload; //! NOT NEEDED AFTER TESTING
    //! PRETENDING TMI TRIGGERED:
    testRaiderArray = [
        "matissetec",
        "itsoik",
        "oik_does_python",
        "developerrig",
    ];
    testRaiderAmount = [15, 20, 10, 5];
    const channel = "itsoik",
        username = testRaiderArray[numberOfRaiders],
        raidAmount = testRaiderAmount[numberOfRaiders];
    numberOfRaiders++;
    return startRaid(channel, username, raidAmount);
}
// ! -------------------- SEND TESTRAID BROADCAST TO EXT END -------------------- //
