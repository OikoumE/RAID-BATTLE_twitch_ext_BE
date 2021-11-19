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
// TODO broadcast endgame state from EBS to EXT, with game result
// TODO calculate game result
// TODO FE: clean up
// TODO fine tune timer, add to timer, multiraid
// TODO sending gameOverState: win/defeated raiderX/loose

// TODO fix full cleanup happening before gameResultDuration instead of fater like intended
// TODO if raider == dead && timeLeft > 1 {gameResultDuration (timestamp) is NOW+gameResultDuration}

//! --------------------------------------------------------- //
//*                      -- MY VARS --                       //
//! ------------------------------------------------------- //
const tmi = require("tmi.js");
const fetch = require("node-fetch");
const { MongoClient } = require("mongodb");
const ObjectId = require("mongodb").ObjectId;
const { channel } = require("diagnostics_channel");
const { stringify } = require("querystring");
const mongoUri = process.env.MONGODB_URL;

//* twitch api auth
const APP_CLIENT_ID =
        process.env.APP_CLIENT_ID || "epcjd8cqin8efwuwgs9m8ubpjnbw90",
    APP_CLIENT_SECRET = process.env.APP_CLIENT_SECRET || "",
    // CURRENT_VERSION = process.env.CURRENT_VERSION || "0.0.4";
    CURRENT_VERSION = "0.0.4";

let APP_ACCESS_TOKEN = null,
    TOKEN_EXPIRE_DATE = null;

const initialHealth = 100,
    channelRaiders = {},
    KEEP_HEROKU_ALIVE_INTERVAL = 15;
var dataBase, tmiClient;

const defaults = {
    // is set as defaults in the DB every server launch
    // change here if need to change naywhere
    gameDuration: { default: 120, max: 300, min: 60 },
    extendGameDuration: { default: 60, max: 180, min: 0 },
    extendGameDurationEnabled: { default: true },
    introDuration: { default: 30, max: 60, min: 0 },
    gameResultDuration: { default: 15, max: 30, min: 0 },
    enableChatOutput: { default: false },
    gameInfoDuration: { default: 10, max: 20, min: 0 },
};
const strings = {
    //TODO rework strings
    intro1: "Incoming Raid from: %s",
    intro2: "Get ready to Battle!",
    help: "Use !raidbattle for help on how to battle",
    win: "%s was victorious over %s!",
    draw: "%s met their equal in %s, its a draw!",
    halfHealth: "%s has around 50% left!",
    dead: "%s has been defeated!",
    gameOver: "GAME OVER",
    // both raiders must be below 50% for streamer to win
    // if any raider above 50%, team raider wins
};
//! -------------------- my vars -------------------- //

async function printTimeout() {
    var date = new Date();
    let nextTimeout =
        Math.floor(
            Math.random() *
                Math.floor(Math.random() * KEEP_HEROKU_ALIVE_INTERVAL)
        ) *
        60 *
        1000;

    console.log();
    setTimeout(async () => {
        fetch("https://raid-battle-twitch-ext.herokuapp.com/").then((res) =>
            console.log(
                "[backend:107]: Herokupinger returned: ",
                res.status,
                `next ping in ${date.toLocaleTimeString()} - ${Math.floor(
                    nextTimeout / 1000 / 60
                )} min`
            )
        );
        printTimeout();
    }, nextTimeout);
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
    const dataBaseUserData = await dataBase.find();
    const result = parseTmiChannelListFromDb(dataBaseUserData);
    await setDefaultUserConfigInDatabase();
    startTmi(result);
}

async function setDefaultUserConfigInDatabase() {
    const dbResult = await dataBase.updateOne(
        {
            _id: new ObjectId("61967a961ffcc7b266231e85"),
        },
        {
            $set: {
                config: {
                    broadcaster: defaults,
                },
            },
        },
        "defaults"
    );
    // console.log("[backend:192]: result", dbResult);
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
    server.route({
        method: "POST",
        path: "/TESTRAID/stop",
        handler: stopTestRaidHandler, //
    });
    server.route({
        method: "POST",
        path: "/matisse/",
        handler: warmHandler, //
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

async function warmHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    let response;
    try {
        if (channelId == 468106723 || channelId == 93645775) {
            const data = req.payload;
            const jsonData = JSON.parse(data);
            url = `http://matissesprojects.github.io/send/heat/yolkRocks?x=${jsonData.x}&y=${jsonData.y}`;
            res = await fetch(url);
            response = await res.text();
            console.log(response);
            if (
                response.includes("not found") &&
                response.includes("ERR_NGROK")
            ) {
                throw "ngrok error";
            }
        } else {
            response = "unauthorized";
        }
    } catch (err) {
        response = "MatisseNGROK error";
        console.log("MatisseNGROK error");
    }
    // return `
    // <p id="thing">hello: ${data.chanelId}</p>
    // `;
    return JSON.stringify({ data: response });
}

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
        console.log(`[backend:302]: no documents found:`, result);
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
    if (!Array.isArray(channelRaiders[channelId].games)) {
        console.log("[backend:321]: No active games");
        return null;
    }
    return JSON.stringify(channelRaiders[channelId].games);
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
        return JSON.stringify({
            result: "Loaded user config",
            data: { result, defaults },
        });
    }
    return JSON.stringify({
        result: "Did not find config, hit save to store config",
        data: { defaults },
    });
}

async function updateUserConfigHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    const jsonUpdateDocument = JSON.parse(req.payload),
        updateDocument = parseUserConfigUpdateDocument(jsonUpdateDocument);
    await addNewStreamer(channelId);
    const updateResult = await dataBase.updateOne(
        { channelId },
        { $set: { userConfig: updateDocument } }
    );
    return JSON.stringify({
        result: "User Config updated!",
        data: updateResult,
    });
}

function parseUserConfigUpdateDocument(document) {
    const parsedDoc = {};
    for (const [key, value] of Object.entries(document)) {
        const max = defaults[key].max,
            min = defaults[key].min;
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
    if (channelRaiders[channelId].games) {
        for (const gameObj of channelRaiders[channelId].games) {
            if (
                gameObj.raiderData.display_name.toLowerCase() ==
                raider.toLowerCase()
            ) {
                if (gameObj.raiderData.health < 100) {
                    console.log(
                        `increase health on : ${raider} in stream: ${channelId}, by ${opaqueUserId}`
                    );
                    gameObj.raiderData.health =
                        gameObj.raiderData.health + gameObj.supportRatio.raider;
                }
                break;
            }
        }
        return channelRaiders[channelId].games;
    }
    console.log("[backend:493]: returning null");
    return "NO ACTIVE GAMES RUNNING; STOP ALL RUNNING GAMES";
}
function streamerSupportHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    // Bot abuse prevention:  don't allow a user to spam the button.
    if (userIsInCooldown(opaqueUserId)) {
        throw Boom.tooManyRequests(STRINGS.cooldown);
    }
    if (channelRaiders[channelId] && channelRaiders[channelId].games) {
        console.log(
            `reduce health on all raiders in stream: ${channelId}, by ${opaqueUserId}`
        );
        for (const gameObj of channelRaiders[channelId].games) {
            if (gameObj.raiderData.health > 0) {
                //! TEST
                if (channelId == 93645775) {
                    gameObj.raiderData.health = gameObj.raiderData.health - 20;
                }
                //! TEST
                gameObj.raiderData.health =
                    gameObj.raiderData.health - gameObj.supportRatio.streamer;
            }
        }
        return channelRaiders[channelId].games;
    }
    console.log("[backend:520]: returning null");
    return "NO ACTIVE GAMES RUNNING; STOP ALL RUNNING GAMES";
}
async function startTestRaidHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    const testRaidPayload = JSON.parse(req.payload);
    // console.log("[backend:566]: testRaidPayload", testRaidPayload);
    await addNewStreamer(channelId);
    const channel = await dataBase.findOne({ channelId });
    const startedRaid = await startRaid(
        channel.channelName,
        testRaidPayload.testRaider,
        testRaidPayload.testAmount
    );
    return JSON.stringify(startedRaid);
}
async function stopTestRaidHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    clearInterval(channelRaiders[channelId].interval);
    channelRaiders[channelId].games.length = 0;
    attemptRaidBroadcast(channelId);
    return JSON.stringify({
        result: `Stopped all raid-games on channel: ${channelId}`,
    });
}

//! --------------------------------------------------------- //
//*                      -- BROADCAST --                     //
//! ------------------------------------------------------- //

function startBroadcastInterval(channelId) {
    if (channelRaiders[channelId].interval) {
        clearInterval(channelRaiders[channelId].interval);
    }
    const gameExpired = checkIfGameExpired(channelRaiders[channelId].games);
    if (!gameExpired) {
        channelRaiders[channelId].interval = setInterval(() => {
            checkGameTimeAndBroadcast(channelId);
        }, 1000);
    } else {
        clearInterval(channelRaiders[channelId].interval);
        //TODO clean up games list
        if (gameExpired) {
            channelRaiders[channelId].interval = null;
            channelRaiders[channelId].games.length = 0;
            attemptRaidBroadcast(channelId);
        }
    }
}

function checkGameTimeAndBroadcast(channelId) {
    if (!checkIfGameExpired(channelRaiders[channelId].games)) {
        specialCondition(channelId);
        attemptRaidBroadcast(channelId);
    } else {
        startBroadcastInterval(channelId);
    }
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

async function sendRaidBroadcast(channelId) {
    // Set the HTTP headers required by the Twitch API.
    const headers = {
        "Client-ID": clientId,
        "Content-Type": "application/json",
        Authorization: bearerPrefix + makeServerToken(channelId),
    };
    // Create the POST body for the Twitch API request.
    const body = JSON.stringify({
        content_type: "application/json",
        broadcaster_id: channelId,
        message: JSON.stringify(channelRaiders[channelId].games),
        target: ["broadcast"],
    });
    // Send the broadcast request to the Twitch API.
    const url = "https://api.twitch.tv/helix/extensions/pubsub";
    const res = await fetch(url, { method: "POST", headers, body });
    console.log(
        "[backend:503]: ",
        `Broadcasting to channelId: ${channelId}`,
        `Response: ${res.status}`
    );
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
    // console.log("[backend:446]: ratio", ratio);
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
    console.log(
        `[backend:549]: Starting raid on channel: ${channel}, started by: ${username}`
    );
    //# HERE
    const streamerData = await dataBase.findOne({ channelName: channel }),
        channelId = streamerData.channelId;
    if (typeof channelRaiders[channelId] !== "object") {
        const games = [],
            interval = null;
        channelRaiders[channelId] = { games, interval };
    }
    if (
        !channelRaiders[channelId].games.some(
            (game) => game.raiderData.raider === username
        )
    ) {
        const raidPackage = await constructRaidPackage(
            username,
            viewers,
            streamerData
        );
        channelRaiders[channelId].games.push(raidPackage);
        setResult(channelId, username, parse(strings.intro1, username));
        //! TEST
        // setTimeout(() => {
        //     setResult(channelId, username, parse(strings.intro1, username));
        // }, 30 * 1000);
        //! TEST
    }
    attemptRaidBroadcast(channelId);
    //! TEST CHAT!
    // sendChatMessageToChannel(
    //     `Starting RAID-BATTLE on channel: ${channel}, started by: ${username}`,
    //     channelId
    // );
    //! TEST CHAT!
    startBroadcastInterval(channelId);
    if (channelRaiders[channelId].games) {
        console.log(
            "[backend:844]: StartRaid returned: channelRaiders[channelId].games"
        );
        return channelRaiders[channelId].games;
    } else {
        console.log("[backend:850]:StartRaid returned:, Null");
        return null;
    }
}

async function constructRaidPackage(
    raiderUserName,
    raiderAmount,
    streamerData
) {
    const streamData = await getStreamById(streamerData.channelId),
        raiderUserData = await getUser(`login=${raiderUserName}`),
        raiderData = {
            display_name: raiderUserData.display_name,
            profile_image_url: raiderUserData.profile_image_url,
            viewers: raiderAmount,
            health: initialHealth,
        },
        supportRatio = getRatio(raiderAmount, streamData.viewer_count),
        gameTimeObj = constructGameTimeObject(streamerData),
        gameResult = [];
    return {
        streamerData,
        raiderData,
        supportRatio,
        gameTimeObj,
        gameResult,
    };
}

function parse(str) {
    var args = [].slice.call(arguments, 1),
        i = 0;
    return str.replace(/%s/g, () => args[i++]);
}

// setResult(channelId, raider, parse(strings.intro1, raider));
function checkForExistingGameResult(testArray, testKey, testValue) {
    return testArray.some(function (o) {
        return o[testKey] === testValue;
    });
    // will be true if pair is found, otherwise false.
}
function specialCondition(channelId) {
    const gamesArray = channelRaiders[channelId].games;
    //is met?
    // TODO check if gametime
    // TODO check if ANY raider.health < 1
    // TODO check if ALL raider.health < 1
    let deathCount = 0;
    for (const game of gamesArray) {
        // check if raider is at 50% health
        if (
            game.raiderData.health <= 50 &&
            !checkForExistingGameResult(
                game.gameResult,
                "string",
                parse(strings.halfHealth, game.raiderData.display_name)
            )
        ) {
            console.log("raider under 50% and not in resultqueue");
            setResult(
                channelId,
                game.raiderData.display_name,
                parse(strings.halfHealth, game.raiderData.display_name)
            );
        }
        // check if raider is below 1hp
        if (
            game.raiderData.health < 1 &&
            !checkForExistingGameResult(
                game.gameResult,
                "string",
                parse(strings.dead, game.raiderData.display_name)
            )
        ) {
            setResult(
                channelId,
                game.raiderData.display_name,
                parse(strings.dead, game.raiderData.display_name)
            );
        }
    }

    const gameDuration = Math.max(
        ...gamesArray.map((game) => game.gameTimeObj.gameDuration)
    );
    // gametime has run out
    // get survivers at/above 50hp, deads below 50hp
    var alive = 0;
    const gameEndResult = gamesArray.map((game) => {
        if (game.raiderData.health >= 50) {
            alive++;
            return { name: game.raiderData.display_name, alive: true };
        } else if (game.raiderData.health < 50) {
            alive--;
            return { name: game.raiderData.display_name, alive: false };
        }
    });
    if (gameDuration < Date.now() / 1000) {
        for (const result of gameEndResult) {
            if (result.alive) {
                alive++;
            } else {
                alive--;
            }
        }
        console.log("[backend:1061]: alive", alive);
        console.log(
            "[backend:1062]: gameEndResult.length",
            gameEndResult.length
        );
        if (alive == -gameEndResult.length) {
            // TODO streamer win
            //! if all had less than 50%
            gameEndResult;
            setResult(
                channelId,
                gameEndResult[0].name,
                parse(
                    strings.win,
                    gamesArray[0].streamerData.displayName,
                    gameEndResult[0].name
                )
            );
        } else if (alive) {
            //! if any raider > 50%, raiders win
            // TODO raiders win
            console.log("[backend:1078]: gameEndResult", gameEndResult);
            setResult(
                channelId,
                gameEndResult[0].name,
                parse(
                    strings.win,
                    gameEndResult[0].name,
                    gamesArray[0].streamerData.displayName
                )
            );
        }
        console.log("[backend:1054]: gameEndResult", gameEndResult);
    }
    gamesArray.map((game) =>
        game.raiderData.health < 1 ? deathCount++ : null
    );
    if (deathCount == gamesArray.length) {
        // no more players
        //! ALL raiders hp == 0
        clearInterval(channelRaiders[channelId].interval);
        // set endResult
        setResult(
            channelId,
            gameEndResult[0].name,
            parse(
                // make result string
                strings.win,
                gameEndResult[0].name,
                gamesArray[0].streamerData.displayName
            )
        );
        // do final broadcast
        attemptRaidBroadcast(channelId);
        channelRaiders[channelId].games.length = 0;
        console.log(
            "[backend:1013]: No more players, stopping broadcast and cleaning up"
        );
        console.log("[backend:1014]: sending final broadcast");
    }
}

function setResult(channelId, raider, string, finalResult = false) {
    // sets a result on a game if a special condition is met
    // channelRaiders[channelId] == Array
    for (let i = 0; i < channelRaiders[channelId].games.length; i++) {
        const raiderGame = channelRaiders[channelId].games[i];
        if (
            raiderGame.raiderData.display_name.toLowerCase() ==
            raider.toLowerCase()
        ) {
            // TODO
            const streamerData =
                channelRaiders[channelId].games[i].streamerData;
            let defaultExpire = defaults.gameInfoDuration.default,
                gameResultDuration = defaults.gameResultDuration.default,
                streamerExpire = streamerData.userConfig.gameInfoDuration,
                streamerResultDuration =
                    streamerData.userConfig.gameResultDuration;
            let addedTime = 0;
            if (finalResult) {
                // check if streamer result duration is set if not use default
                addedTime = streamerResultDuration
                    ? streamerResultDuration
                    : gameResultDuration;
            } else {
                addedTime = streamerExpire ? streamerExpire : defaultExpire;
            }
            const resultExpires = Date.now() + addedTime * 1000;
            channelRaiders[channelId].games[i].gameResult.push({
                resultExpires,
                string,
            });
        }
    }
}

//! --------------------------------------------------------- //
//*                      -- TIMEKEEPER --                    //
//! ------------------------------------------------------- //
function checkIfGameExpired(gamesArray) {
    //
    const stateArray = gamesArray.map(
        (game) => Date.now() / 1000 >= game.gameTimeObj.gameResultDuration
    );
    for (let i = 0; i < stateArray.length; i++) {
        if (!stateArray[i]) {
            return false;
        }
    }
    return true;
}
function constructGameTimeObject(streamerData) {
    // handles creating the gameTimeObj: {gameDuration, introDuration, gameResultDuration}
    const introDuration = calculateIntroDuration(streamerData),
        gameDuration = calculateGameDuration(introDuration, streamerData),
        gameResultDuration = calculateGameResultDuration(
            gameDuration,
            streamerData
        );
    return { introDuration, gameDuration, gameResultDuration };
}
function calculateIntroDuration(streamerData) {
    // set introDuration on gameTimeObj
    introDuration = Math.floor(
        Date.now() / 1000 +
            (streamerData.userConfig
                ? streamerData.userConfig.introDuration
                : defaults.introDuration.default)
    );
    return introDuration;
}
function calculateGameDuration(introDuration, streamerData) {
    // set gameDuration on gameTimeObj
    // if there are more than 0 games in the list use extendGameDuration
    const userConfig = streamerData.userConfig;
    if (
        channelRaiders[streamerData.channelId].games &&
        channelRaiders[streamerData.channelId].games.length >= 1
    ) {
        // using extendGameDuration if ongoing game
        const ongoingGame = Math.max(
            ...channelRaiders[streamerData.channelId].games.map(
                (game) => game.gameTimeObj.gameDuration
            )
        );
        let extraTime = 0;
        if (userConfig && userConfig.extendGameDurationEnabled) {
            extraTime = streamerData.userConfig
                ? streamerData.userConfig.extendGameDuration
                : defaults.extendGameDuration.default;
        }
        gameDuration = Math.floor(ongoingGame + extraTime);
    } else {
        // using streamerData if no other games are running
        // or defaults if no streamerData.userConfig
        gameDuration = Math.floor(
            introDuration +
                (streamerData.userConfig
                    ? streamerData.userConfig.gameDuration
                    : defaults.gameDuration.default)
        );
    }
    return gameDuration;
}
function calculateGameResultDuration(gameDuration, streamerData) {
    // set gameResultDuration on gameTimeObj
    gameResultDuration = Math.floor(
        gameDuration +
            (streamerData.userConfig
                ? streamerData.userConfig.gameResultDuration
                : defaults.gameResultDuration.default)
    );
    return gameResultDuration;
}

//! --------------------------------------------------------- //
//*                       -- CHAT API --                     //
//! ------------------------------------------------------- //
//TODO wait for API to get fixed!!!!!!!!!!!

async function sendChatMessageToChannel(message, channelId) {
    // not more often than every 5sec
    // Maximum: 280 characters.
    console.log(`sending message: "${message}" to channel: "${channelId}"`);
    const jwtToken = makeServerToken(channelId);
    const url = `https://api.twitch.tv/helix/extensions/chat?broadcaster_id=${channelId}`,
        headers = {
            "Client-ID": clientId,
            Authorization: "Bearer " + jwtToken,
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
