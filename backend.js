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
// const request = require("request");

// The developer rig uses self-signed certificates.  Node doesn't accept them
// by default.  Do not use this in production.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// Use verbose logging during development.  Set this to false for production.
const verboseLogging = true;
const verboseLog = verboseLogging ? console.log.bind(console) : () => {};

// Service state variables
const serverTokenDurationSec = 30; // our tokens for pubsub expire after 30 seconds
const userCooldownMs = 100; // maximum input rate per user to prevent bot abuse
const userSkipCooldownMs = 10; // maximum input rate per user to prevent bot abuse
const userCooldownClearIntervalMs = 60000; // interval to reset our tracking object
const channelCooldownMs = 1000; // maximum broadcast rate per channel
const bearerPrefix = "Bearer "; // HTTP authorization headers have this prefix
const channelCooldowns = {}; // rate limit compliance
let userCooldowns = {}; // spam prevention
// const { resolveObjectURL } = require("buffer");
// const { get } = require("https");

//! --------------------------------------------------------- //
//*                      -- TODO's --                        //
//! ------------------------------------------------------- //
// TODO DB:
// Make a logger that logs critical errors to DB
// log pr channelID: timestamp, error, scriptLocation

// TODO broadcast endgame state from EBS to EXT, with game result
// TODO calculate game result
// TODO sending gameOverState: win/defeated raiderX/loose

//! TODO fix full cleanup happening before gameResultDuration instead of later like intended
//! TODO if raider == dead && timeLeft > 1 {gameResultDuration (timestamp) is NOW+gameResultDuration}

// TODO figure out a way to remove channels from channels to monitor list.

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
    CURRENT_VERSION = process.env.CURRENT_VERSION;
// CURRENT_VERSION = "0.0.4";

let APP_ACCESS_TOKEN = null,
    TOKEN_EXPIRE_DATE = null;

const initialHealth = 100,
    channelRaiders = {},
    KEEP_HEROKU_ALIVE_INTERVAL = 15,
    CHAT_MSG_COOLDOWN_MS = 10000,
    channelMessageCooldown = {};

var dataBase, tmiClient;

const DEFAULTS = {
    // is set as DEFAULTS in the DB every server launch
    // change here if need to change naywhere
    gameDuration: { default: 120, max: 300, min: 60 },
    extendGameDuration: { default: 60, max: 180, min: 0 },
    extendGameDurationEnabled: { default: true },
    introDuration: { default: 30, max: 60, min: 0 },
    gameResultDuration: { default: 15, max: 30, min: 0 },
    enableChatOutput: { default: true },
    enableChatCommands: { default: true },
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
    RAIDBATTLE_CHAT_INFO_TEXT:
        "RAID BATTLE is a game that is triggered when a channel that has the extension installed is being raided. The raiders & viewers can choose to support either the {RAIDER} or the {STREAMER} by clicking the respective buttons on screen",
    // both raiders must be below 50% for streamer to win
    // if any raider above 50%, team raider wins
};
//! -------------------- /my_vars -------------------- //

function herokuPingerTimerouter() {
    // handles setting an interval of Math.random() to ping heroku to keep app alive
    //* no need after setting up proper VPS
    let nextTimeout =
        Math.floor(
            Math.random() * 5 +
                Math.floor(Math.random() * KEEP_HEROKU_ALIVE_INTERVAL)
        ) *
        60 *
        1000;
    // nextTimeout < 5 ? herokuPingerTimerouter() : nextTimeout;
    return nextTimeout;
}

async function herokuPinger() {
    // handles pinging heroku to keep app alive
    var date = new Date();
    let nextTimeout = herokuPingerTimerouter();
    setTimeout(async () => {
        fetch("https://raid-battle-twitch-ext.herokuapp.com/").then((res) =>
            console.log(
                "[backend:107]: HerokuPinger returned: ",
                res.status,
                `, PINGED@: ${date.toLocaleTimeString()}, next ping in  - ${Math.floor(
                    nextTimeout / 1000 / 60
                )} min`
            )
        );
        herokuPinger();
    }, nextTimeout);
}
herokuPinger();

const STRINGS = {
    secretEnv: usingValue("secret"),
    clientIdEnv: usingValue("client-id"),
    ownerIdEnv: usingValue("owner-id"),
    serverStarted: "Server running at",
    secretMissing: missingValue("secret", "EXT_SECRET"),
    clientIdMissing: missingValue("client ID", "EXT_CLIENT_ID"),
    ownerIdMissing: missingValue("owner ID", "EXT_OWNER_ID"),
    messageSendError: "Error sending message to channel %s: %s",
    pubsubResponse: "Broadcast to c:%s returned %s",
    cooldown: "Please wait before clicking again",
    invalidAuthHeader: "Invalid authorization header",
    invalidJwt: "Invalid JWT",
};
function usingValue(name) {
    return `Using environment variable for ${name}`;
}
function missingValue(name, variable) {
    const option = name.charAt(0);
    return `Extension ${name} required.\nUse argument "-${option} <${name}>" or environment variable "${variable}".`;
}
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

//! --------------------------------------------------------- //
//*                     -- ON LAUNCH --                      //
//! ------------------------------------------------------- //
async function onLaunch() {
    //this run when server starts up
    dataBase = new DataBase(mongoUri);
    await dataBase.connect();
    console.log("[backend:130]: Server starting");
    const dataBaseUserData = await dataBase.find();
    const result = parseTmiChannelListFromDb(dataBaseUserData);
    await setDefaultUserConfigInDatabase();
    startTmi(result);
}

async function setDefaultUserConfigInDatabase() {
    // handles setting database.defaultConfig to values in DEFAULTS
    const dbResult = await dataBase.updateOne(
        {
            _id: new ObjectId("61967a961ffcc7b266231e85"),
        },
        {
            $set: {
                config: {
                    broadcaster: DEFAULTS,
                },
            },
        },
        "defaults"
        //!!!!!!!!!
    );
    // console.log("[backend:192]: result", dbResult);
}
//! --------------------------------------------------------- //
//*                      -- ROUTE's --                       //
//! ------------------------------------------------------- //
(async () => {
    // Handle adding new streamers to channels to watch for raids
    server.route({
        method: "POST",
        path: "/addStreamerToChannels/",
        handler: addStreamerToChannelsHandler, //
    });
    // Handle broadcaster requesting userConfig
    server.route({
        method: "GET",
        path: "/requestUserConfig/",
        handler: requestUserConfigHandler, //
    });
    // Handle broadcaster updating userConfig
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
    // Handle a viewer request ongoing game.
    server.route({
        method: "GET",
        path: "/ongoingRaidGame/",
        handler: ongoingRaidGameQueryHandler,
    });
    // Handle an attempt to load a route in browser.
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
    // Handle stop broadcasting a testraid
    server.route({
        method: "POST",
        path: "/TESTRAID/stop",
        handler: stopTestRaidHandler, //
    });
    // Matisse stuff
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

//! --------------------------------------------------------- //
//*                   -- ROUTE HANDLERS --                   //
//! ------------------------------------------------------- //

function userIsInCooldown(opaqueUserId, skipCooldown = false) {
    // Check if the user is in cool-down.
    const cooldown = userCooldowns[opaqueUserId];
    const now = Date.now();
    if (cooldown && cooldown > now) {
        return true;
    }
    // Voting extensions must also track per-user votes to prevent skew.
    userCooldowns[opaqueUserId] =
        now + skipCooldown ? userSkipCooldownMs : userCooldownMs;
    return false;
}

//! ---- 404 ---- //
function return404(req) {
    return "<style> html { background-color: #000000;} </style><img src='https://http.cat/404.jpg' />";
}
//! ---- WARM ---- //
async function warmHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    // Bot abuse prevention:  don't allow a user to spam the button.
    if (userIsInCooldown(opaqueUserId)) {
        throw Boom.tooManyRequests(STRINGS.cooldown);
    }
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
        console.log("[backend:312]: ", response);
    }
    return JSON.stringify({ data: response });
}
//! ---- ONGOING ---- //
async function ongoingRaidGameQueryHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    // Bot abuse prevention:  don't allow a user to spam the button.
    if (userIsInCooldown(opaqueUserId)) {
        throw Boom.tooManyRequests(STRINGS.cooldown);
    }
    const result = await dataBase.findOne({ channelId });
    if (!result) {
        addNewStreamer(channelId);
    }
    if (typeof channelRaiders[channelId] === "undefined") {
        console.log("[backend:522]: No active games");
        return null;
    } else if (
        channelRaiders[channelId] &&
        typeof channelRaiders[channelId].games === "undefined"
    ) {
        console.log("[backend:528]: No active games");
        return null;
    } else if (
        channelRaiders[channelId] &&
        channelRaiders[channelId].games.length < 1
    ) {
        console.log("[backend:534]: No active games");
        return null;
    }
    return JSON.stringify(channelRaiders[channelId].games);
}
//! ---- ADDSTREAMER ---- //
async function addStreamerToChannelsHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    // Bot abuse prevention:  don't allow a user to spam the button.
    if (userIsInCooldown(opaqueUserId, true)) {
        throw Boom.tooManyRequests(STRINGS.cooldown);
    }
    const result = await addNewStreamer(channelId);
    return JSON.stringify(result);
}
//! ---- REQUESTCONFIG ---- //
async function requestUserConfigHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    // Bot abuse prevention:  don't allow a user to spam the button.
    if (userIsInCooldown(opaqueUserId, true)) {
        throw Boom.tooManyRequests(STRINGS.cooldown);
    }
    const result = await dataBase.findOne({ channelId });
    if (result.userConfig) {
        return JSON.stringify({
            result: "Loaded user config",
            data: { result: result.userConfig, defaults: DEFAULTS },
        });
    }
    return JSON.stringify({
        result: "Did not find config, hit save to store config",
        data: { result: null, defaults: DEFAULTS },
    });
}
//
//! ---- UPDATECONFIG ---- //
async function updateUserConfigHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    // Bot abuse prevention:  don't allow a user to spam the button.
    if (userIsInCooldown(opaqueUserId)) {
        throw Boom.tooManyRequests(STRINGS.cooldown);
    }
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
//! ---- PARSECONFIG ---- //
function parseUserConfigUpdateDocument(document) {
    // parses userConfig update document
    const parsedDoc = {};
    for (const [key, value] of Object.entries(document)) {
        const max = DEFAULTS[key].max,
            min = DEFAULTS[key].min;
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
//! ---- RAIDERSUPPORT ---- //
function raiderSupportHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    // Bot abuse prevention:  don't allow a user to spam the button.
    if (userIsInCooldown(opaqueUserId)) {
        throw Boom.tooManyRequests(STRINGS.cooldown);
    }
    const raider = req.params.raider;
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
//! ---- STREAMERSUPPoRT ---- //
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
            `[backend:627]: reduce health on all raiders in stream: ${channelId}, by ${opaqueUserId}`
        );
        for (const gameObj of channelRaiders[channelId].games) {
            if (gameObj.raiderData.health > 0) {
                //! DURING TEST
                if (opaqueUserId == "U93645775") {
                    gameObj.raiderData.health = gameObj.raiderData.health - 20;
                }
                //! DURING TEST
                gameObj.raiderData.health =
                    gameObj.raiderData.health - gameObj.supportRatio.streamer;
            }
        }
        return channelRaiders[channelId].games;
    }
    console.log("[backend:520]: returning null");
    return "NO ACTIVE GAMES RUNNING; STOP ALL RUNNING GAMES";
}
//! ---- STARTTESTRAID ---- //
async function startTestRaidHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    // Bot abuse prevention:  don't allow a user to spam the button.
    if (userIsInCooldown(opaqueUserId)) {
        throw Boom.tooManyRequests(STRINGS.cooldown);
    }
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
//! ---- STOPTESTRAID ---- //
async function stopTestRaidHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    // Bot abuse prevention:  don't allow a user to spam the button.
    if (userIsInCooldown(opaqueUserId)) {
        throw Boom.tooManyRequests(STRINGS.cooldown);
    }
    cleanUpChannelRaiderAndDoBroadcast(channelId);
    return JSON.stringify({
        result: `Stopped all raid-games on channel: ${channelId}`,
    });
}

//! --------------------------------------------------------- //
//*                       -- DATABASE --                     //
//! ------------------------------------------------------- //
class DataBase {
    // class for handling all database functions
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
}
//! -------------------- DATABASE HANDLERS -------------------- //
async function addNewStreamer(channelId) {
    // checks if user already in database and adds new streamer to database if user does not already exsist
    const userExsist = await dataBase.checkIfUserInDb(channelId);
    let returnData;
    if (!userExsist) {
        const userData = await getUser(`id=${channelId}`);
        const result = await addStreamerToDb(userData);
        console.log("[backend:337]: result", result);
        const allChannelList = await dataBase.find();
        const newChannelList = parseTmiChannelListFromDb(allChannelList);
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
    // adds streamer to database
    const result = await dataBase.insertOne({
        channelName: userData.display_name.toLowerCase(),
        displayName: userData.display_name,
        channelId: userData.id,
        profilePicUrl: userData.profile_image_url,
    });
    return result;
}
function parseTmiChannelListFromDb(result) {
    // parses result from database and returns a list of channels for TMI.js to join
    const channels = [];
    for (const document of result) {
        channels.push(document.channelName);
    }
    return channels;
}

//! --------------------------------------------------------- //
//*                      -- TWITCH API --                    //
//! ------------------------------------------------------- //
async function getAppAccessToken() {
    // gets APP_ACCESS_TOKEN token from twitch
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
    // calculates ratio of raiders:viewers
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
    // starts tmi and joins channels, register to listen for "onRaided" events
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
    tmiClient.on("message", (channel, userstate, message, self) =>
        chatCommandHandler(channel, userstate, message, self)
    );
    tmiClient.on("raided", async (channel, username, viewers) => {
        // channel: String - Channel name being raided
        // username: String - Username raiding the channel
        // viewers: Integer - Viewers count
        console.log(
            `[backend:536]: ${channel} was raided by: ${username} with ${viewers} viewers`
        );
        channel = channel.replace("#", "");
        viewers = parseInt(viewers);
        await startRaid(channel, username, viewers);
    });
}

async function chatCommandHandler(channel, userstate, message, self) {
    // checks if chatCommands are enabled and sends a message if it is
    const streamerData = await dataBase.findOne({
        channelName: channel.replace("#", "").toLowerCase(),
    });
    let chatCommandsEnabled = DEFAULTS.enableChatCommands.default;
    if (streamerData.userConfig) {
        chatCommandsEnabled = streamerData.userConfig.enableChatCommands;
    }
    // Don't listen to my own messages or if chatCommands are disabled
    if (self || !chatCommandsEnabled) return;
    // if message is of type chat and is a command
    if (userstate["message-type"] === "chat" && streamerData) {
        if (
            message.startsWith("!") &&
            message.toLowerCase().includes("raidbattle")
        ) {
            if (message.toLowerCase().includes("madeby")) {
                attemptSendChatMessageToChannel(
                    streamerData,
                    "Was made by @itsOiK"
                );
                return;
            }
            // send message to chat
            console.log(
                `[backend:838]: Command: "${message}"  recognized on channel: ${channel}`
            );
            attemptSendChatMessageToChannel(
                streamerData,
                strings.RAIDBATTLE_CHAT_INFO_TEXT
            );
        }
    }
}

function restartTmi(channelList) {
    // restarts TMI.js
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

//! --------------------------------------------------------- //
//*                  -- GAME CONDITION --                    //
//! ------------------------------------------------------- //
async function startRaid(channel, username, viewers) {
    // starts a raid game
    console.log(
        `[backend:549]: Starting raid on channel: ${channel}, started by: ${username}`
    );
    //# HERE
    const streamerData = await dataBase.findOne({ channelName: channel }),
        channelId = streamerData.channelId;
    if (typeof channelRaiders[channelId] !== "object") {
        channelRaiders[channelId] = {
            games: [],
            interval: null,
            hasRunningGame: true,
            finalBroadcastTimeout: null,
        };
    }
    if (
        !channelRaiders[channelId].games.some(
            (game) => game.raiderData.raider === username
        )
    ) {
        let result = null;
        const gamePackage = await constructGamePackage(
            username,
            viewers,
            streamerData,
            channelId
        );
        if (gamePackage) {
            setResult(
                channelId,
                username,
                parse(strings.intro1, username),
                "introDuration"
            );
            attemptSendChatMessageToChannel(
                streamerData,
                `Incoming raid from ${username} - get ready for RAID-BATTLE ${
                    (await getUserConfigOrDefaultValue(
                        channelId,
                        "enableChatCommands"
                    ))
                        ? "(type !RAIDBATTLE for info)"
                        : ""
                }`
            );
            handleBroadcastInterval(channelId);
            result = channelRaiders[channelId].games;
        }
        console.log(
            `[backend:906]: StartRaid returned: ${
                result == null ? "Null" : "channelRaiders[channelId].games"
            }:`
        );
        return result;
    }
}

async function getUserConfigOrDefaultValue(channelId, configName) {
    // gets userConfig value or DEFAULT value
    const streamerData = await dataBase.findOne({ channelId });
    let result = DEFAULTS[`${configName}`].default;
    if (streamerData && streamerData.userConfig) {
        // we have userconfig
        result = streamerData.userConfig[`${configName}`];
    }
    return result;
}

async function constructGamePackage(
    raiderUserName,
    raiderAmount,
    streamerData,
    channelId
) {
    // constructs an object for a raid game
    const streamData = await getStreamById(streamerData.channelId);
    if (streamData.type == "live") {
        const raiderUserData = await getUser(`login=${raiderUserName}`),
            raiderData = {
                display_name: raiderUserData.display_name,
                profile_image_url: raiderUserData.profile_image_url,
                viewers: raiderAmount,
                health: initialHealth,
            },
            supportRatio = getRatio(raiderAmount, streamData.viewer_count),
            gameTimeObj = await constructGameTimeObject(streamerData),
            gameResult = [],
            raidPackage = {
                streamerData,
                raiderData,
                supportRatio,
                gameTimeObj,
                gameResult,
            };
        channelRaiders[channelId].games.push(raidPackage);
        return raidPackage;
    } else {
        return null;
    }
}

function conditionHandler(channelId) {
    // Checks if certain conditions are met and
    // perform required tasks accodringly
    const gamesArray = channelRaiders[channelId].games;
    // get raiders at/below 50hp and set result
    checkRaiderHealthAndSetResult(channelId, gamesArray, 50, "halfHealth");
    // get raiders below 1hp and set result
    checkRaiderHealthAndSetResult(channelId, gamesArray, 1, "dead");
    // gametime has run out
    const gameEndResult = calculateGameEndResult(gamesArray);
    // check if all raiders are dead and set result
    setAllRaiderDeadCondition(gamesArray, channelId, gameEndResult);
    // check if game is expired and set result
    setGameExpiredResult(gamesArray, channelId, gameEndResult);
}
function checkRaiderHealthAndSetResult(
    channelId,
    gamesArray,
    healthThreshold,
    stringName
) {
    // checks if a specified raider has reached a specified health threshhold
    for (const game of gamesArray) {
        // check if raider is at 50% health
        if (
            game.raiderData.health <= healthThreshold &&
            !checkForExistingGameResult(
                game.gameResult,
                "string",
                parse(strings[stringName], game.raiderData.display_name)
            )
        ) {
            console.log(
                "[backend:957]: raider under 50% and not in resultqueue"
            );
            setResult(
                channelId,
                game.raiderData.display_name,
                parse(strings[stringName], game.raiderData.display_name),
                "gameInfoDuration"
            );
        }
    }
}
function calculateGameEndResult(gamesArray) {
    // handles calculating the end game result
    let alive = 0;
    const result = gamesArray.map((game) => {
        if (game.raiderData.health >= 50) {
            alive++;
            return { name: game.raiderData.display_name, alive: true };
        } else if (game.raiderData.health < 50) {
            alive--;
            return { name: game.raiderData.display_name, alive: false };
        }
    });
    return { result, alive };
}
function setGameExpiredResult(gamesArray, channelId, gameEnd) {
    // handles calculating the end game result when gameDuration is expired
    if (gameExpired(gamesArray) && channelRaiders[channelId].hasRunningGame) {
        let winner, defeated;
        if (gameEnd.result.length + gameEnd.alive == 0) {
            // if all had less than 50%, "STREAMER" wins
            winner = gamesArray[0].streamerData.displayName;
            defeated = gameEnd.result[0].name;
        } else if (gameEnd.alive) {
            // if any raider > 50%, "RAIDER[0]" win
            winner = gameEnd.result[0].name;
            defeated = gamesArray[0].streamerData.displayName;
        }
        if (
            !checkForExistingGameResult(
                gamesArray[0].gameResult,
                "string",
                parse(strings.win, winner, defeated)
            )
        ) {
            console.log("[backend:1078]: gameEnd.result", gameEnd.result);
            setResult(
                channelId,
                gameEnd.result[0].name,
                parse(strings.win, winner, defeated),
                "gameResultDuration"
            );
        }
        sendFinalBroadcastTimeout(channelId);
    }
}
function setAllRaiderDeadCondition(gamesArray, channelId, gameEnd) {
    // handles setting condition when all raiders are dead
    //! STREAMER WIN
    const maxHealth = Math.max(
        ...gamesArray.map((game) => parseInt(game.raiderData.health))
    );
    if (maxHealth < 1 && channelRaiders[channelId].hasRunningGame) {
        // no more players
        // set endResult
        if (
            !checkForExistingGameResult(
                gamesArray[0].gameResult,
                "string",
                parse(
                    strings.win,
                    gamesArray[0].streamerData.displayName,
                    gameEnd.result[0].name
                )
            )
        ) {
            setResult(
                channelId,
                gameEnd.result[0].name,
                parse(
                    strings.win,
                    gamesArray[0].streamerData.displayName,
                    gameEnd.result[0].name
                ),
                "gameResultDuration"
            );
        }
        // do final broadcast
        sendFinalBroadcastTimeout(channelId);
    }
}
//! --------------------  -------------------- //
function parse(str) {
    // parses string and replaces "%s" with supplied argument
    var args = [].slice.call(arguments, 1),
        i = 0;
    return str.replace(/%s/g, () => args[i++]);
}

function checkForExistingGameResult(testArray, testKey, testValue) {
    // checks if a specified game result already exsists
    return testArray.some(function (o) {
        return o[testKey] === testValue;
    });
    // will be true if pair is found, otherwise false.
}
async function setResult(channelId, raider, string, durationName) {
    // sets a result on a game if a special condition is met
    // channelRaiders[channelId] == Array
    for (let i = 0; i < channelRaiders[channelId].games.length; i++) {
        const raiderGame = channelRaiders[channelId].games[i];
        if (
            raiderGame.raiderData.display_name.toLowerCase() ==
            raider.toLowerCase()
        ) {
            const addedTime = await getUserConfigOrDefaultValue(
                channelId,
                durationName
            );
            const resultExpires = Date.now() + addedTime * 1000;
            channelRaiders[channelId].games[i].gameResult.push({
                resultExpires,
                string,
            });
            break;
        }
    }
}

//! --------------------------------------------------------- //
//*                      -- TIMEKEEPER --                    //
//! ------------------------------------------------------- //
function gameExpired(gamesArray) {
    // calculates if gameDuration of a game has expired
    const gameDuration = Math.max(
        ...gamesArray.map((game) => game.gameTimeObj.gameDuration)
    );
    if (gameDuration >= Date.now() / 1000) {
        //* GAME NOT EXPIRED
        return false;
    }
    //! GAME EXPIRED
    return true;
}
async function constructGameTimeObject(streamerData) {
    // handles creating the gameTimeObj: {gameDuration, introDuration, gameResultDuration}
    const introDuration = await calculateIntroDuration(streamerData),
        gameDuration = await calculateGameDuration(introDuration, streamerData),
        gameResultDuration = await getUserConfigOrDefaultValue(
            streamerData.channelId,
            "gameDuration"
        );
    return { introDuration, gameDuration, gameResultDuration };
}
async function calculateIntroDuration(streamerData) {
    // set introDuration on gameTimeObj
    introDuration = Math.floor(
        Date.now() / 1000 +
            (await getUserConfigOrDefaultValue(
                streamerData.channelId,
                "introDuration"
            ))
    );
    return introDuration;
}
async function calculateGameDuration(introDuration, streamerData) {
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
            extraTime = await getUserConfigOrDefaultValue(
                streamerData.channelId,
                "extendGameDuration"
            );
        }
        gameDuration = Math.floor(ongoingGame + extraTime);
    } else {
        // using streamerData if no other games are running
        // or DEFAULTS if no streamerData.userConfig
        gameDuration = Math.floor(
            introDuration +
                (await getUserConfigOrDefaultValue(
                    streamerData.channelId,
                    "gameDuration"
                ))
        );
    }
    return gameDuration;
}

//! --------------------------------------------------------- //
//*                      -- BROADCAST --                     //
//! ------------------------------------------------------- //
//! ---- INTERVAL ---- //
function handleBroadcastInterval(channelId) {
    // handles setting/resetting interval for broadcasting during active game
    if (channelRaiders[channelId].interval) {
        clearInterval(channelRaiders[channelId].interval);
    }
    channelRaiders[channelId].interval = setInterval(() => {
        broadcastInterval(channelId);
    }, 1000);
}
function broadcastInterval(channelId) {
    // handles setting coditions and attempting broadcast at an interval
    conditionHandler(channelId);
    attemptRaidBroadcast(channelId);
}
//! ---- FINAL ---- //
async function sendFinalBroadcastTimeout(channelId) {
    if (!channelRaiders[channelId].finalBroadcastTimeout) {
        // sends a final broadcast after a timeOut(USER_CONFIG.gameResultDuration)
        const timeout = await getUserConfigOrDefaultValue(
            channelId,
            "gameResultDuration"
        );
        console.log(
            "[backend:713]:sending final broadcast in: ",
            timeout,
            " sec!"
        );
        channelRaiders[channelId].finalBroadcastTimeout = setTimeout(() => {
            cleanUpChannelRaiderAndDoBroadcast(channelId);
        }, timeout * 1000);
    }
}

//! ---- CLEAN ---- //
function cleanUpChannelRaiderAndDoBroadcast(channelId) {
    // cleans up channelraider list, ends game and attempts a broadcast
    try {
        if (channelRaiders[channelId]) {
            console.log(
                "[backend:685]: cleaning up and sending final broadcast"
            );
            clearInterval(channelRaiders[channelId].interval);
            channelRaiders[channelId].interval = null;
            channelRaiders[channelId].hasRunningGame = false;
            channelRaiders[channelId].finalBroadcastTimeout = null;
            channelRaiders[channelId].games = [];
            channelRaiders[channelId].games.push("GAME OVER");
            attemptRaidBroadcast(channelId);
            setTimeout(() => {
                channelRaiders[channelId] = "null";
            }, 2000);
        }
    } catch (err) {
        console.log();
    }
}
//! ---- QUEUE ---- //
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
//! ---- SEND ---- //
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
//*                       -- CHAT API --                     //
//! ------------------------------------------------------- //
function attemptSendChatMessageToChannel(streamerData, message) {
    // checks if USER_CONFIG.enableChatOutput is true and sends message
    if (streamerData.userConfig) {
        if (!streamerData.userConfig.enableChatOutput) {
            // dont send message if user has disabled chat output in config
            return;
        }
    }
    // checks if there is timeout for sending message
    const cooldown = channelMessageCooldown[streamerData.channelId],
        now = Date.now();
    if (!cooldown || cooldown.time < now) {
        // we are not in cooldown
        sendChatMessageToChannel(message, streamerData.channelId);
        channelMessageCooldown[streamerData.channelId] = {
            time: now + CHAT_MSG_COOLDOWN_MS,
        };
    }
}

async function sendChatMessageToChannel(message, channelId) {
    // sends a message to a specified channelID
    // not more often than every 5sec pr channel
    // Maximum: 280 characters.
    console.log(
        `[backend:1321]: sending message: "${message}" to channel: "${channelId}"`
    );
    const jwtToken = makeServerToken(channelId);
    const url = `https://api.twitch.tv/helix/extensions/chat?broadcaster_id=${channelId}`,
        headers = {
            "Client-ID": clientId,
            Authorization: "Bearer " + jwtToken,
            "Content-Type": "application/json",
        },
        body = JSON.stringify({
            // text: message,
            text: message,
            extension_id: clientId,
            extension_version: CURRENT_VERSION,
        });
    const res = await fetch(url, { method: "POST", headers, body });
    console.log(
        `[backend:1338]: Broadcast chat message result: ${res.status}: ${res.statusText}`
    );
}
//! --------------------------------------------------------- //
//*                     -- JWT TOKEN --                      //
//! ------------------------------------------------------- //
// Create and return a JWT for use by this service.
function makeServerToken(channelId) {
    // makes a JWT token
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
