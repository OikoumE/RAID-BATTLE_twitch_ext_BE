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
const { channel } = require("diagnostics_channel");
const { stringify } = require("querystring");
const mongoUri = process.env.MONGODB_URL;

//* twitch api auth
const APP_CLIENT_ID =
        process.env.APP_CLIENT_ID || "cr20njfkgll4okyrhag7xxph270sqk", //! CHANGE WITH OWN EXT SPECIFIC APP CLIENT ID!
    APP_CLIENT_SECRET = process.env.APP_CLIENT_SECRET || "",
    // CURRENT_VERSION = process.env.CURRENT_VERSION || "0.0.4";
    CURRENT_VERSION = "0.0.4";

let APP_ACCESS_TOKEN = null,
    TOKEN_EXPIRE_DATE = null;

const initialHealth = 100,
    channelRaiders = {},
    KEEP_HEROKU_ALIVE_INTERVAL = 5;
var dataBase, tmiClient;

const defaultUserConfig = {
    gameDuration: { default: 120, max: 300, min: 60 },
    extendGameDuration: { default: 60, max: 180, min: 0 },
    extendGameDurationEnabled: { default: true },
    introDuration: { default: 30, max: 60, min: 0 },
    gameResultDuration: { default: 30, max: 60, min: 0 },
    enableChatOutput: { default: false },
};

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
    // Handle adding new streamers to channels to watch for raids
    server.route({
        method: "POST",
        path: "/addStreamerToChannels/",
        handler: addStreamerToChannelsHandler, //
    });
    // Handle user requesting userConfig
    server.route({
        method: "POST",
        path: "/requestUserConfig/",
        handler: requestUserConfigHandler, //
    });
    // Handle user updating userConfig
    server.route({
        method: "POST",
        path: "/updateUserConfig/",
        handler: updateUserConfigHandler, //
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
    //! TESTING
    // Handle broadcasting a testraid
    server.route({
        method: "POST",
        path: "/TESTRAID/",
        handler: startTestRaidHandler, //
    });
    //! /TESTING
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
function makeLegacyServerToken(channelId) {
    const payload = {
        exp: Math.floor(Date.now() / 1000) + serverTokenDurationSec,
        user_id: ownerId, // extension owner ID for the call to Twitch PubSub
        role: "external",
        channel_id: channelId,
        pubsub_perms: {
            send: ["broadcast"],
        },
    };
    return jsonwebtoken.sign(payload, secret, { algorithm: "HS256" });
}
function makeHelixServerToken(channelId) {
    const payload = {
        exp: Math.floor(Date.now() / 1000) + serverTokenDurationSec,
        user_id: ownerId, // extension owner ID for the call to Twitch PubSub
        role: "external",
        channel_id: channelId,
        pubsub_perms: {
            send: ["broadcast"],
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
    async updateOne(
        filterDocument,
        updateDocument,
        collection = this.collection
    ) {
        const result = await this.client
            .db(this.dataBaseName)
            .collection(collection)
            .updateOne(filterDocument, updateDocument);
        return result;
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
    let returnData;
    if (!userExsist) {
        const userData = await getUser(`id=${channelId}`);
        const result = await addStreamerToDb(userData);
        console.log("[backend:337]: result", result);
        const allChannelList = await dataBase.find();
        const newChannelList = parseTmiChannelListFromDb(allChannelList);
        console.log("[backend:446]: newChannelList", newChannelList);
        restartTmi(newChannelList);
        returnData = {
            result: "Success, added to channels to monitor for raids",
            data: result,
        };
    } else {
        returnData = {
            result: "Already in the list of channels to monitor for raid",
            data: null,
        };
    }
    return returnData;
}
async function addStreamerToDb(userData) {
    const result = await dataBase.insertOne({
        channelName: userData.display_name.toLowerCase(),
        displayName: userData.display_name,
        channelId: userData.id,
        profilePicUrl: userData.profile_image_url,
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
    return JSON.stringify(channelRaiders[channelId]);
}

async function addStreamerToChannelsHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    const result = await addNewStreamer(channelId);
    return JSON.stringify(result);
}

async function requestUserConfigHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    const result = await dataBase.findOne({ channelId });
    if (result) {
        return JSON.stringify({ result: "Loaded user config", data: result });
    }
    return JSON.stringify({
        result: "Did not find config, hit save to store config",
        data: null,
    });
}

async function updateUserConfigHandler(req) {
    // Verify all requests.

    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    const jsonUpdateDocument = JSON.parse(req.payload),
        updateDocument = parseUserConfigUpdateDocument(jsonUpdateDocument);

    const updateResult = await dataBase.updateOne(
        { channelId },
        { $set: { userConfig: updateDocument } }
    );
    return JSON.stringify({
        result: "User Config updated!",
        data: updateResult,
    });
    //TODO depending on success with DB, return result
}

function parseUserConfigUpdateDocument(document) {
    const parsedDoc = {};
    for (const [key, value] of Object.entries(document)) {
        const max = defaultUserConfig[key].max,
            min = defaultUserConfig[key].min;
        if (!key.toLowerCase().includes("enable")) {
            parsedDoc[key] = parseInt(
                value > max ? max : value < min ? min : value
            );
        } else {
            parsedDoc[key] = value;
        }
    }
    return parsedDoc;
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
    // increase health on specific raider
    console.log(channelRaiders[channelId]);
    if (channelRaiders[channelId]) {
        for (const raiderObj of channelRaiders[channelId]) {
            if (raiderObj.raider == raider) {
                if (raiderObj.health < 100) {
                    console.log(
                        `increase health on : ${raider} in stream: ${channelId}, by ${opaqueUserId}`
                    );
                    raiderObj.health =
                        raiderObj.health + raiderObj.supportRatio.raider;
                }
                break;
            }
        }
        return channelRaiders[channelId];
    }
    console.log("[backend:493]: returning null");
    return "NO ACTIVE GAMES RUNNING; STOP ALL RUNNING GAMES";

    // Broadcast the health change to all other extension instances on this channel.
    // attemptHealthBroadcast(channelId);
    // attemptRaidBroadcast(channelId)
}
function streamerSupportHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    // Bot abuse prevention:  don't allow a user to spam the button.
    if (userIsInCooldown(opaqueUserId)) {
        throw Boom.tooManyRequests(STRINGS.cooldown);
    }
    if (channelRaiders[channelId]) {
        for (const raiderObj of channelRaiders[channelId]) {
            if (raiderObj.health >= 1) {
                console.log(
                    `reduce health on all raiders in stream: ${channelId}, by ${opaqueUserId}`
                );
                raiderObj.health =
                    raiderObj.health - raiderObj.supportRatio.streamer;
            }
        }
        return channelRaiders[channelId];
    }
    console.log("[backend:520]: returning null");
    return "NO ACTIVE GAMES RUNNING; STOP ALL RUNNING GAMES";

    // Broadcast the health change to all other extension instances on this channel.
    // attemptHealthBroadcast(channelId);
    // attemptRaidBroadcast(channelId)
}
async function startTestRaidHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    const testRaidPayload = JSON.parse(req.payload);
    // console.log("[backend:566]: testRaidPayload", testRaidPayload);
    const channel = await dataBase.findOne({ channelId });
    return JSON.stringify(
        startRaid(
            channel.channelName,
            testRaidPayload.testRaider,
            testRaidPayload.testAmount
        )
    );
}

//! --------------------------------------------------------- //
//*                  -- BROADCAST TO EXT --                  //
//! ------------------------------------------------------- //
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

async function sendRaidBroadcast(channelId) {
    // Set the HTTP headers required by the Twitch API.
    const headers = {
        "Client-ID": clientId,
        "Content-Type": "application/json",
        Authorization: bearerPrefix + makeLegacyServerToken(channelId),
    };
    // Create the POST body for the Twitch API request.
    const body = JSON.stringify({
        content_type: "application/json",
        broadcaster_id: channelId,
        message: JSON.stringify(channelRaiders[channelId]),
        target: ["broadcast"],
    });
    // Send the broadcast request to the Twitch API.
    console.log(
        "[backend:612]: channelRaiders[channelId]",
        channelRaiders[channelId]
    );
    console.log(
        "[backend:497]:",
        `Broadcasting channelRaidersArray for channelId: ${channelId}`
    );
    const url = "https://api.twitch.tv/helix/extensions/pubsub";
    const res = await fetch(url, { method: "POST", headers, body });
    console.log(
        "[backend:503]: Result sending message to channel",
        channelId,
        res.status
    );
}

//! --------------------------------------------------------- //
//*                       -- CHAT API --                     //
//! ------------------------------------------------------- //
//TODO FIGURE OUT TWITCH BULLSHIT DOCS!!!!!!!!!!!
//! sendChatMessageToChannel(
//!     `Starting RAID-BATTLE on channel: ${channel}, started by: ${username}`,
//!     channelId
//! );

async function sendChatMessageToChannel(message, channelId) {
    // not more often than every 5sec
    // Maximum: 280 characters.

    console.log(`sending message: "${message}" to channel: "${channelId}"`);
    const bullshitToken = makeHelixServerToken(channelId);
    const url = `https://api.twitch.tv/helix/extensions/chat?broadcaster_id=${channelId}`,
        headers = {
            "Client-ID": clientId,
            Authorization: "Bearer " + bullshitToken,
            "Content-Type": "application/json",
        },
        body = JSON.stringify({
            // text: message,
            text: "Test Message",
            extension_id: clientId,
            extension_version: CURRENT_VERSION,
        });
    const res = await fetch(url, { method: "POST", headers, body });
    console.log(
        `[backend:532]: Broadcast chat message result: ${res.status}: ${res.statusText}`
    );
}

// TODO store a (date.now()/1000 + userConfig.gameDuration) in a GAME when in starts
// TODO add to timer if new raid during game
// TODO timerthingy
// TODO start counting down when game start
// TODO attempt broadcast every second with updated TIMELEFT if game is still running
// TODO reset health after X time
// TODO sending gameOverState: win/defeated raiderX/loose
// TODO when game end send final broadcast to end game on frontend and clean up

let timeLeftBroadcast;
function startBroadcastInterval(channelId) {
    if (!timeLeftBroadcast) {
        timeLeftBroadcast = setTimeout(() => {
            if (!checkIfGameExpired(channelRaiders[channelId])) {
                attemptRaidBroadcast(channelId);
                startBroadcastInterval(channelId);
            } else {
                //broadcast end raid game
            }
        }, 1000);
    }
}

function checkIfGameExpired(gameArray) {
    const stateArray = [];
    for (const game of gameArray) {
        if (Date.now() / 1000 >= game.gameExpireTime) {
            stateArray.push(true);
        } else {
            stateArray.push(false);
        }
    }
    for (let i = 0; i < stateArray.length; i++) {
        if (!stateArray[i]) {
            return false;
        }
    }
    return true;
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
            return data.data[0];
        } else {
            console.log("[backend:618]: response", response);
        }
    } catch (err) {
        console.log("[backend:674]: Error when getting user by ID", err);
    }
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
            return data.data[0];
        } else {
            console.log("[backend:593]: response", response);
        }
    } catch (err) {
        console.log("[backend:661]: Error when getting stream by ID", err);
    }
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
        console.log(
            `[backend:536]: ${channel} was raided by: ${username} with ${viewers} viewers`
        );
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
    //TODO this calles broadcastTimeleft
    console.log(
        `[backend:549]: Starting raid on channel: ${channel}, started by: ${username}`
    );
    const streamerData = await dataBase.findOne({ channelName: channel }),
        channelId = streamerData.channelId,
        raidPackage = await constructRaidPackage(
            channelId,
            username,
            viewers,
            streamerData
        );

    if (!Array.isArray(channelRaiders[channelId])) {
        channelRaiders[channelId] = [];
    }
    if (!channelRaiders[channelId].some((item) => item.raider === username)) {
        channelRaiders[channelId].push(raidPackage);
    }
    // attemptRaidBroadcast(channelId); //!
    startBroadcastInterval(channelId); //*
    if (channelRaiders[channelId]) {
        return channelRaiders[channelId];
    } else {
        return null;
    }
}

async function constructRaidPackage(
    channelId,
    raiderUserName,
    raiderAmount,
    streamerData
) {
    const streamData = await getStreamById(channelId),
        currentViewers = streamData.viewer_count,
        raiderData = await getUser(`login=${raiderUserName}`),
        raiderPicUrl = raiderData.profile_image_url, //.userPicUrl
        streamerPicUrl = streamerData.profilePicUrl, // HAVE IN DB
        supportRatio = getRatio(raiderAmount, currentViewers),
        gameExpireTime =
            Date.now() / 1000 + streamerData.userConfig.gameDuration ||
            defaultUserConfig.gameDuration.default;

    return {
        channel: streamerData.channelName,
        raider: raiderUserName,
        health: initialHealth,
        viewers: raiderAmount,
        currentViewers,
        supportRatio,
        raiderPicUrl,
        streamerPicUrl,
        gameExpireTime,
    };
}
