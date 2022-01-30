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
import fs from "fs";
import path from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

import { dirname } from "path";
import { fileURLToPath } from "url";
import { ObjectId } from "mongodb";

import Boom from "boom";
import jsonwebtoken from "jsonwebtoken";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import tmi from "tmi.js";
import fetch from "node-fetch";

dotenv.config();

import { DataBase } from "./modules/database/database.mjs";
import { webhookCallback, getEventSubEndpoint, EventSubRegister } from "./modules/eventsub/index.mjs";

//TODO potentially request auth on config:
// -   [channel.raid](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types#channelraid)
// -   [stream.online](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types#streamonline)
// -   [stream.offline](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types#streamoffline)
// -   [user.authorization.grant](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types#userauthorizationgrant)
// -   [user.authorization.revoke](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types#userauthorizationrevoke)

//! ------------------------------------------------

// The developer rig uses self-signed certificates.  Node doesn't accept them
// by default.  Do not use this in production
// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; //! ONLY WHEN DEV AND TESTING

// Service state variables
const serverTokenDurationSec = 30; // our tokens for pubsub expire after 30 seconds
const userCooldownMs = 100; // maximum input rate per user to prevent bot abuse
const userSkipCooldownMs = 10; // maximum input rate per user to prevent bot abuse
const userCooldownClearIntervalMs = 60000; // interval to reset our tracking object
const channelCooldowns = {}; // rate limit compliance
const channelCooldownMs = 1000; // maximum broadcast rate per channel
const bearerPrefix = "Bearer "; // HTTP authorization headers have this prefix
let userCooldowns = {}; // spam prevention

//! --------------------------------------------------------- //
//*                      -- MY VARS --                       //
//! ------------------------------------------------------- //
//* twitch api auth
const APP_CLIENT_ID = process.env.APP_CLIENT_ID,
    APP_CLIENT_SECRET = process.env.APP_CLIENT_SECRET,
    CURRENT_VERSION = process.env.CURRENT_VERSION,
    EXT_OWNER_ID = process.env.EXT_OWNER_ID,
    EXT_CLIENT_SECRET = process.env.EXT_CLIENT_SECRET,
    EXT_CLIENT_ID = process.env.EXT_CLIENT_ID;

const EVENTSUB_ENDPOINT = "https://api.twitch.tv/helix/eventsub/subscriptions",
    EVENTSUB_ENDPOINT_PATH = process.env.EVENTSUB_ENDPOINT_PATH;

const ownerId = EXT_OWNER_ID,
    secret = Buffer.from(EXT_CLIENT_SECRET, "base64"),
    clientId = EXT_CLIENT_ID;

let APP_ACCESS_TOKEN = process.env.APP_ACCESS_TOKEN || null,
    TOKEN_EXPIRE_DATE = process.env.TOKEN_EXPIRE_DATE || null;

const initialSupport = 0,
    channelRaiders = {},
    CHAT_MSG_COOLDOWN_MS = 5000,
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
    enableOverlayButton: { default: true },
};
const strings = {
    intro1: "Incoming Raid from: %s",
    intro2: "Get ready to Battle!",
    help: "Use !raidbattle for help on how to battle",
    win: "%s was victorious over %s!",
    draw: "%s met their equal in %s, its a draw!",
    halfHealth: "%s has around %s % left!",
    dead: "%s has been defeated!",
    gameOver: "GAME OVER",
    RAIDBATTLE_CHAT_INFO_TEXT:
        "RAID BATTLE is a game that is triggered when a channel that has the extension installed is being raided. The raiders & viewers can choose to support either the {RAIDER} or the {STREAMER} by clicking the respective buttons on screen",
};
const BATTLE_HISTORY = {
    win: "Won",
    lost: "Lost",
    draw: "Draw",
};
const STRINGS = {
    secretEnv: usingValue("secret"),
    clientIdEnv: usingValue("client-id"),
    ownerIdEnv: usingValue("owner-id"),
    serverStarted: "Server running at: ",
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
//! --------------------------------------------------------- //
//*                      -- EXPRESS --                       //
//! ------------------------------------------------------- //
const app = express();
const port = process.env.PORT || 8085;
const ip = "0.0.0.0";
app.use(cors());
app.use(
    express.raw({
        // Need raw message body for signature verification
        type: "application/json",
    })
);
//! --------------------------------------------------------- //
//*                     -- ON LAUNCH --                      //
//! ------------------------------------------------------- //
async function onLaunch() {
    //this run when server starts up
    await getAppAccessToken();
    dataBase = new DataBase();
    await dataBase.connect();
    console.log("[backend:130]: Server starting");
    const dataBaseUserData = await dataBase.find();
    const result = parseTmiChannelListFromDb(dataBaseUserData);
    inserLatestNewsInDb(); //! dev
    await setDefaultUserConfigInDatabase();
    startTmi(result);

    // await deleteEventSubEndpoint("93645775"); //! DEV ONCE
    await setEventsubOnAll(); //! DEV ONCE

    setInterval(() => {
        // Periodically clear cool-down tracking to prevent unbounded growth due to
        // per-session logged-out user tokens.
        userCooldowns = {};
    }, userCooldownClearIntervalMs);
}
onLaunch();
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
    );
}
async function getUserConfigOrDefaultValue(channelId, configName) {
    // gets userConfig value or DEFAULT value
    const streamerData = await dataBase.findOne({ channelId });
    let result = DEFAULTS[configName].default;
    if (streamerData && streamerData.userConfig) {
        // we have userconfig
        const userConfValue = streamerData.userConfig[configName];
        if (Number.isInteger(userConfValue) || typeof userConfValue === "boolean") {
            return userConfValue;
        }
    }
    return result;
}
//! --------------------------------------------------------- //
//*                      -- ROUTE's --                       //
//! ------------------------------------------------------- //
const confirmUser = [isUserConfirmed, confirmOpaqueUser];
// Handle an attempt to load a route in browser.
app.get("/", return404);

// Handle adding new streamers to channels to watch for raids
app.post("/addStreamerToChannels/", confirmUser, addStreamerToChannelsHandler);

// Handle broadcaster requesting userConfig
app.get("/requestUserConfig/", confirmUser, requestUserConfigHandler);

// Handle broadcaster updating userConfig
app.post("/updateUserConfig/", confirmUser, updateUserConfigHandler);

// Handle broadcasting a testraid
app.post("/TESTRAID/", confirmUser, startTestRaidHandler);

// Handle stop broadcasting a testraid
app.post("/TESTRAID/stop", confirmUser, stopTestRaidHandler);

// Handle getting Latest News
app.get("/getLatestNews/", confirmUser, getLatestNewsHandler);

// Handle viewer requesting raidHistory
app.get("/requestRaidHistory/", isUserConfirmed, requestRaidHistoryHandler);

// Handle a viewer request to support the raider.
app.post("/heal/", isUserConfirmed, raiderSupportHandler);

// Handle a viewer request to support the streamer.
app.post("/damage/", isUserConfirmed, streamerSupportHandler);

// Handle a viewer request ongoing game.
app.get("/ongoingRaidGame/", isUserConfirmed, ongoingRaidGameQueryHandler);

// Handle EventSub notifications from twitch
app.post("/" + EVENTSUB_ENDPOINT_PATH, async (req, res) => {
    await webhookCallback({
        req,
        res,
        callbackObj: {
            startRaid,
            addNewStreamer,
            deleteEventSubEndpoint,
            streamStatusHandler,
        },
    });
});
//! --------------------------------------------------------- //
//*                       -- SERVER --                       //
//! ------------------------------------------------------- //
const server = app.listen(port, ip, () => {
    const time = new Date();
    console.log(`[backend:254]: ${time} - HTTP - server running at ${ip}:${port}/`);
});
//! ----- EVENTSUB ----- //
async function streamStatusHandler(eventNotification) {
    // Handle response (stream.offline/online)
    let offlineStreamId = null;
    if (!Object.keys(eventNotification).includes("type")) {
        // add offline stream to array to exclude from rest of code
        offlineStreamId = eventNotification.broadcaster_user_id;
    }
    const result = await getExtLiveStreams();
    //grab EXT live streams and filter/map channelId's
    const liveStreamsArray = result
        .filter((streamObj) => {
            if (offlineStreamId != streamObj.broadcaster_id) return streamObj;
        })
        .map((streamObj) => {
            return streamObj.broadcaster_id;
        });
    // serach DB for channelId's
    const liveStreamsDatabaseData = await dataBase.find({ channelId: { $in: liveStreamsArray } });
    // extract wanted data and send
    const dataTosend = liveStreamsDatabaseData.map((liveStream) => {
        const { score, channelId, displayName } = liveStream;
        return { score, channelId, displayName };
    });
    await sendGlobalBroadcast(dataTosend);
}
async function getExtLiveStreams() {
    const url = `https://api.twitch.tv/helix/extensions/live?extension_id=${process.env.EXT_CLIENT_ID}&first=100`;
    const result = await paginated_fetch(url);
    return result;
}
async function paginated_fetch(url, page = null, previousResponse = []) {
    const appToken = await getAppAccessToken(),
        headers = {
            Authorization: `Bearer ${appToken}`,
            "Client-Id": APP_CLIENT_ID,
            "Content-type": "application/json",
        };
    return fetch(`${url}${page ? `&after={page}` : ""}`, {
        headers,
    })
        .then((response) => response.json())
        .then(async (newResponse) => {
            if (newResponse.data) {
                const response = [...previousResponse, ...newResponse.data]; // Combine the two arrays
                if (newResponse.pagination && newResponse.data.length == 100) {
                    console.log("[backend:315]: doing pagination");
                    return await paginated_fetch(url, newResponse.pagination, response);
                }
                return response;
            }
            return newResponse;
        })
        .catch((err) => {
            console.log("[backend:311]: ERROR: ", err);
        });
}

//! --------------------------------------------------------- //
//*                   -- ROUTE HANDLERS --                   //
//! ------------------------------------------------------- //
//! ---- STATUSCAT ---- //
function return404() {
    return "<style> html { background-color: #000000;} </style><img src='https://http.cat/404.jpg' />";
}
function return400() {
    return "<style> html { background-color: #000000;} </style><img src='https://http.cat/400.jpg' />";
}
function return200() {
    return "<style> html { background-color: #000000;} </style><img src='https://http.cat/200.jpg' />";
}
//! ---- ONGOING ---- //
async function ongoingRaidGameQueryHandler(req, res) {
    const { channelId, opaqueUserId } = res.locals;
    const result = await dataBase.findOne({ channelId });
    const { userConfig } = result;
    if (!result) {
        addNewStreamer(channelId);
    }
    const noActiveGameString = `No active games on channel ${
        result ? result.displayName : null
    } - ${channelId} (${opaqueUserId})`;

    if (typeof channelRaiders[channelId] === "undefined") {
        console.log(`[backend:415]: ${noActiveGameString}`);
        res.json(userConfig);
        return;
    } else if (channelRaiders[channelId] && typeof channelRaiders[channelId]?.data?.games === "undefined") {
        console.log(`[backend:421]: ${noActiveGameString}`);
        res.json(userConfig);
        return;
    } else if (channelRaiders[channelId] && channelRaiders[channelId]?.data?.games.length < 1) {
        console.log(`[backend:427]: ${noActiveGameString}`);
        res.json(userConfig);
        return;
    }
    res.json(formatGameData(channelId));
}
//! ---- ADDSTREAMER ---- //
async function addStreamerToChannelsHandler(req, res) {
    const { channelId, opaqueUserId } = res.locals;
    const result = await addNewStreamer(channelId);
    res.json({ result: "Added to list of channels to monitor for raid", data: result });
}
//! ---- REQUESTCONFIG ---- //
async function requestUserConfigHandler(req, res) {
    const { channelId, opaqueUserId } = res.locals;
    try {
        const result = await dataBase.findOne({ channelId });
        if (result && result.userConfig) {
            res.json({
                result: "Loaded user config",
                data: { result: result.userConfig, defaults: DEFAULTS },
            });
            return;
        }
        res.json({
            result: "Did not find config, hit save to store config",
            data: { result: null, defaults: DEFAULTS },
        });
        return;
    } catch (err) {
        console.log("[backend:383]: ERROR:", err);
        res.json({
            result: "Did not find config, hit save to store config",
            data: { result: null, defaults: DEFAULTS },
        });
    }
}
//! ---- UPDATECONFIG ---- //
async function updateUserConfigHandler(req, res) {
    const { channelId, opaqueUserId } = res.locals;
    const jsonUpdateDocument = JSON.parse(req.body),
        updateDocument = parseUserConfigUpdateDocument(jsonUpdateDocument);
    await addNewStreamer(channelId);
    const updateResult = await dataBase.updateOne({ channelId }, { $set: { userConfig: updateDocument } });
    res.json({
        result: "User Config updated!",
        data: updateResult,
    });
    return;
}
//! ---- PARSECONFIG ---- //
function parseUserConfigUpdateDocument(document) {
    // parses userConfig update document
    const parsedDoc = {};
    for (const [key, value] of Object.entries(document)) {
        if (DEFAULTS.hasOwnProperty(key)) {
            const max = DEFAULTS[key].max,
                min = DEFAULTS[key].min;
            if (!key.toLowerCase().includes("enable")) {
                parsedDoc[key] = parseInt(value > max ? max : value < min ? min : value);
            } else {
                parsedDoc[key] = value ? true : false;
            }
        }
    }
    return parsedDoc;
}
//! ---- NEWS HANDLER ---- //
async function getLatestNewsHandler(req, res) {
    const { channelId, opaqueUserId } = res.locals,
        result = await dataBase.find({}, "LatestNews"),
        sortedNews = result.sort((a, b) => b.date - a.date);
    res.json(sortedNews.slice(0, 2));
}
async function inserLatestNewsInDb() {
    //! happens on launch
    const result = await dataBase.find({}, "LatestNews");
    const add_news = {
        date: new Date(),
        content: {
            title: "New version of RAID BATTLE!",
            text: [
                'added "Latest News" to config page',
                "updated support level indicator",
                "added animations to clicks",
                'added "viewerpanel"',
                'added "live Raid Battler`s" to viewerpanel',
                "added info about last 3 raids`s to viewerpanel",
                'added "RaidRoulette" chat command <!raid>',
            ],
        },
    };
    if (!result.some((news) => news.content.title === add_news.content.title)) {
        console.log('[backend:427]: Adding new "news" to database', add_news);
        await dataBase.insertOne(add_news, "LatestNews");
    }
}
//! ---- CLICKHANDLERS ---- //
function raiderSupportHandler(req, res) {
    const { channelId, opaqueUserId } = res.locals;
    // const raider = req.params.raider;
    // increase health on specific raider
    if (channelRaiders[channelId]?.data?.games) {
        clickSupportIncrement(channelId, "raider", opaqueUserId);
        res.json(formatGameData(channelId));
        return; //channelRaiders[channelId].games;
    }
    console.log("[backend:493]: returning null");
    res.sendStatus(204);
}
function streamerSupportHandler(req, res) {
    const { channelId, opaqueUserId } = res.locals;
    if (channelRaiders[channelId]?.data?.games) {
        clickSupportIncrement(channelId, "streamer", opaqueUserId);
        res.json(formatGameData(channelId));
        return; //channelRaiders[channelId].games;
    }
    console.log("[backend:520]: returning null");
    res.sendStatus(204);
}
function clickSupportIncrement(channelId, who, clicker) {
    // increments click counter and adds clicker to list if not already in list
    const clickTracker = channelRaiders[channelId].data.clickTracker,
        { streamer: sTracker, raider: rTracker } = clickTracker;
    const increaseWho = checkSupporter({ clickTracker, who, clicker });
    clickTracker[increaseWho].clicks += 1;
    const streamer = sTracker.clicks > 0 ? sTracker.clicks / sTracker.clickers.length : 0,
        raider = rTracker.clicks > 0 ? rTracker.clicks / rTracker.clickers.length : 0;
    channelRaiders[channelId].data.supportState = streamer - raider;
    return channelRaiders[channelId].data.supportState;
}
function checkSupporter(supporterObj) {
    // prevent cross-support
    const { who, clicker, clickTracker } = supporterObj,
        { streamer: sTracker, raider: rTracker } = clickTracker;
    if (who === "streamer") {
        if (rTracker.clickers.includes(clicker)) return "raider";
        if (!sTracker.clickers.includes(clicker)) {
            sTracker.clickers.push(clicker);
        }
        return "streamer";
    } else if (who === "raider") {
        if (sTracker.clickers.includes(clicker)) return "streamer";
        if (!rTracker.clickers.includes(clicker)) {
            rTracker.clickers.push(clicker);
        }
        return "raider";
    }
}
//! ---- START TESTRAID ---- //
async function startTestRaidHandler(req, res) {
    const { channelId, opaqueUserId } = res.locals;
    let testRaidPayload,
        startedRaid = {};
    try {
        testRaidPayload = JSON.parse(req.body);
        const regex = /^[a-zA-Z0-9][a-zA-Z0-9_]{3,24}$/gs;
        if (testRaidPayload && regex.test(testRaidPayload.testRaider)) {
            // console.log("[backend:566]: testRaidPayload", testRaidPayload);
            await addNewStreamer(channelId);
            const channel = await dataBase.findOne({ channelId });
            const startedRaid = await startRaid(
                {
                    channel: channel.channelName,
                    username: testRaidPayload.testRaider,
                    viewers: testRaidPayload.testAmount,
                },
                true
            );
            if (startedRaid) {
                res.json(formatGameData(channelId));
                return;
            }
        }
    } catch (err) {
        console.log("[backend:541]: ERROR: ", err);
        startedRaid["error"] = err;
    }
    res.json(startedRaid);
    return; //JSON.stringify(startedRaid);
}
//! ---- STOPTESTRAID ---- //
async function stopTestRaidHandler(req, res) {
    const { channelId, opaqueUserId } = res.locals;
    cleanUpChannelRaiderAndDoBroadcast(channelId);
    res.json({
        result: `Stopped all raid-games on channel: ${channelId}`,
    });
    return;
}
//! ---- RAIDHISTORY ---- //
async function requestRaidHistoryHandler(req, res) {
    const { channelId, opaqueUserId } = res.locals;
    const live = await getExtLiveStreams(),
        liveExtStream = live.map((stream) => stream.broadcaster_id);
    const result = await dataBase.find({ channelId: { $in: liveExtStream } }),
        liveExtStreamsData = result
            .filter((streamData) => {
                return streamData.channelId != channelId;
            })
            .map((streamData) => {
                if (streamData.channelId != channelId)
                    return {
                        channelId: streamData.channelId,
                        score: streamData.score,
                        displayName: streamData.displayName,
                    };
            });
    const thisStream = await dataBase.findOne({ channelId }),
        data = {
            thisStreamData: {
                displayName: thisStream.displayName,
                battleHistory: thisStream.battleHistory?.slice(-3),
                score: thisStream.score,
            },
            liveStreamsData: liveExtStreamsData,
        };
    res.json({ result: "Loaded raid history", data });
}

//! -------------------- DATABASE HANDLERS -------------------- //
async function addNewStreamer(channelId) {
    // checks if user already in database and adds new streamer to database if user does not already exsist
    try {
        const result = await checkEventSubUser(channelId);
        console.log("[backend:579]: result", result);
        if (result) {
            // we are happy
            const response = await continueAddingNewStreamer(channelId, result);
            return response;
        } else {
            console.log("[backend:591]: EventSubRegister", channelId);
            if (channelId) await EventSubRegister(channelId);
            else console.trace("[backend:577]: ERROR: INVESTIGATE WHY CHANNELID IS UNDEFINED: channelId:", channelId);
            return;
        }
    } catch (err) {
        console.log("[backend:578]: ERROR: ", err);
    }
}
async function continueAddingNewStreamer(channelId, registeredEventSub) {
    //TODO queue with promises
    const userExsist = await dataBase.checkIfUserInDb(channelId);
    let returnData;
    if (!userExsist) {
        const userData = await getUser(`id=${channelId}`);
        userData["eventSub"] = registeredEventSub;
        //TODO this MAY add twice to DB... fix with promises
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
        if (!userExsist.eventSub || (userExsist.eventSub && userExsist.eventSub.length < 3)) {
            const result = await dataBase.updateOne(
                { channelId },
                {
                    $push: { eventSub: registeredEventSub },
                }
            );
            console.log("[backend:612]: result", result);
        }
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
        created: Date.now(),
        eventSub: userData.eventSub,
        score: 0,
        battleHistory: [],
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
//! -------------------- EVENTSUB HANDLERS -------------------- //
async function checkEventSubUser(userId) {
    const appToken = await getAppAccessToken();
    const eventSubs = await getEventSubEndpoint(appToken);

    if (eventSubs) {
        const enabledEventSubs = eventSubs.filter((eSub) => {
            return (
                eSub.status === "enabled" &&
                (parseInt(eSub.condition.to_broadcaster_user_id) === parseInt(userId) ||
                    parseInt(eSub.condition.broadcaster_user_id) === parseInt(userId))
            );
        });
        if (enabledEventSubs.length === 0) {
            console.log("[backend:655]: userId", userId, "enabledEventSubs", enabledEventSubs);
            return enabledEventSubs;
        } else {
            return enabledEventSubs;
        }
    }
    throw `unable to getEventSubEndpoint: ${eventSubs}`;
}

async function deleteEventSubEndpoint(channelId) {
    const streamerData = await dataBase.findOne({ channelId });
    streamerData.eventSub
        .map((subEvent) => {
            return subEvent.id;
        })
        .forEach(async (eventId) => {
            await callDeleteEventSubEndpont(eventId);
        });
    return;
}

async function callDeleteEventSubEndpont(eventId) {
    const url = EVENTSUB_ENDPOINT + "?id=" + eventId;
    const myAppToken = await getAppAccessToken();
    const headers = {
        Authorization: `Bearer ` + myAppToken,
        "Client-Id": APP_CLIENT_ID,
        "Content-type": "application/json",
    };
    const data = {
        headers,
        method: "DELETE",
    };
    console.log("[backend:143]: deleting eventSubId: ", eventId);
    const result = await fetch(url, data);
    if (result.status === 204) {
        // 204	Successfully deleted the subscription.
        console.log("[backend:667]: Subcription successfully deleted: eventId:", eventId);
    } else if (result.status === 404) {
        //404	The subscription was not found.
        console.log("[backend:667]: Subcription not found: eventId:", eventId);
    } else if (result.status === 401) {
        //401	The caller failed authentication. Verify that your access token and client ID are valid.`;
        console.log("[backend:670]: ERROR: ", await result.json());
        console.log("[backend:670]: ERROR: ", result.text());
    }
}
//! --------------------------------------------------------- //
//*                      -- TWITCH API --                    //
//! ------------------------------------------------------- //
async function getAppAccessToken() {
    // gets APP_ACCESS_TOKEN token from twitch
    if (!APP_ACCESS_TOKEN || Date.now() >= TOKEN_EXPIRE_DATE) {
        console.log("[backend:712]: WARNING APP_ACCESS_TOKEN EXPIRED; MAKING NEW!");
        const endpoint = `https://id.twitch.tv/oauth2/token?client_id=${APP_CLIENT_ID}&client_secret=${APP_CLIENT_SECRET}&grant_type=client_credentials`;
        const result = await fetch(endpoint, { method: "POST" });
        if (result.ok) {
            const data = await result.json();
            APP_ACCESS_TOKEN = data.access_token;
            process.env.APP_ACCESS_TOKEN = APP_ACCESS_TOKEN;
            TOKEN_EXPIRE_DATE = Date.now() + data.expires_in * 1000;
            console.log("[backend:719]: TOKEN_EXPIRE_DATE", TOKEN_EXPIRE_DATE);
            console.log("[backend:719]: APP_ACCESS_TOKEN", APP_ACCESS_TOKEN);
        } else {
            //
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
async function getStreamsById(id) {
    // Query Twitch for stream details.
    // only works on live channels
    console.log("[backend:735]: id", id);
    const url = `https://api.twitch.tv/helix/streams?user_id=${id}`,
        appToken = await getAppAccessToken(),
        headers = {
            Authorization: `Bearer ${appToken}`,
            "Client-Id": APP_CLIENT_ID,
        };
    // Handle response.
    try {
        let response = await fetch(url, { headers });
        if (response.status < 400) {
            const data = await response.json();
            if (data.data.length != 0) {
                return data.data[0];
            } else {
                // console.log("[backend:750]: ERROR: No data in 'data': ", data);
                throw `[backend:750]: ERROR: No data in 'data': ${data}`;
            }
        }
    } catch (err) {
        console.log("[backend:755]: Error when getting stream by ID", err);
        return null;
    }
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
        console.log(`[backend:529]: Listening for messages on ${channels.length} channels`);
    });
    tmiClient.on(
        "message",
        async (channel, userstate, message, self) => await chatCommandHandler(channel, userstate, message, self)
    );
}
async function chatCommandHandler(channel, userstate, message, self) {
    // checks if chatCommands are enabled and sends a message if it is
    const channelName = channel.replace("#", "");
    const streamerData = await dataBase.findOne({ channelName: channelName.toLowerCase() });
    let chatCommandsEnabled = DEFAULTS.enableChatCommands.default;
    if (streamerData?.userConfig) {
        chatCommandsEnabled = streamerData.userConfig.enableChatCommands;
    }
    // Don't listen to my own messages or if chatCommands are disabled
    if (self || !chatCommandsEnabled) return;
    // if message is of type chat and is a command
    if (userstate["message-type"] === "chat" && streamerData) {
        if (message.toLowerCase().startsWith("!raidbattle")) {
            if (message.toLowerCase().includes("madeby")) {
                attemptSendChatMessageToChannel(streamerData, "Was made by @itsOiK");
                return;
            }
            attemptSendChatMessageToChannel(streamerData, strings.RAIDBATTLE_CHAT_INFO_TEXT);
        } else if (message.toLowerCase().startsWith("!raid")) {
            if (
                userstate.badges &&
                (Object.keys(userstate.badges).includes("broadcaster") ||
                    Object.keys(userstate.badges).includes("moderator"))
            ) {
                const rouletteString = await raidRoulette(channelName);
                console.log("[backend:859]: rouletteString", rouletteString);
                attemptSendChatMessageToChannel(streamerData, rouletteString);
                return;
            } else {
                const notAllowedString = `Sorry, only ${channelName} or moderators can perform this command`;
                attemptSendChatMessageToChannel(streamerData, notAllowedString);
                return;
            }
        }
    }
}
async function raidRoulette(currentChannel) {
    const result = await getExtLiveStreams();
    const liveStreams = result
        .filter((streamData) => {
            return streamData.broadcaster_name.toLowerCase() != currentChannel.toLowerCase();
        })
        .map((streamData) => {
            return streamData.broadcaster_name;
        });
    if (liveStreams.length > 1) {
        const randomLive = liveStreams[Math.floor(Math.random() * liveStreams.length)];
        return `
            There's ${liveStreams.length} other Raid Battler's currently live, we randomly chose: 
            ${randomLive} as a suggestion for raiding. 
            Copy-Paste this in in chat to raid them: /raid ${randomLive}
        `;
    } else if (liveStreams.length === 1) {
        return `
            There's one other Raid Battler currently live. 
            Copy-Paste this in in chat to raid them: /raid ${liveStreams[0]}
        `;
    } else if (liveStreams.length === 0) {
        return "There are no other Raid Battler's currently live";
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
async function startRaid({ channel, username, viewers }, test = false) {
    // starts a raid game
    const streamerData = await dataBase.findOne({
            channelName: channel.toLowerCase(),
        }),
        { channelName, displayName, channelId, profilePicUrl, score, userConfig, battleHistory } = streamerData,
        mappedStreamer = {
            channelName,
            displayName,
            channelId,
            profilePicUrl,
            score,
            userConfig,
            battleHistory: battleHistory?.slice(-3),
        };
    if (typeof channelRaiders[channelId] !== "object") {
        channelRaiders[channelId] = {
            test,
            interval: null,
            hasRunningGame: true,
            finalBroadcastTimeout: null,
            data: {
                games: [],
                supportState: initialSupport,
                clickTracker: {
                    streamer: { clicks: 0, clickers: [] },
                    raider: { clicks: 0, clickers: [] },
                },
                streamerData: mappedStreamer,
            },
        };
    }
    if (
        !channelRaiders[channelId].data.games.some((game) => {
            return game.raiderData.display_name.toLowerCase() === username.toLowerCase();
        })
    ) {
        console.log(`[backend:549]: Starting raid on channel: ${channel}, started by: ${username}`);
        let result = [];
        const gamePackage = await constructGamePackage(username, viewers, streamerData, channelId);
        if (gamePackage) {
            channelRaiders[channelId].data.games.push(gamePackage);
            setResult(channelId, username, parseString(strings.intro1, username), "introDuration");
            attemptSendChatMessageToChannel(
                streamerData,
                `Incoming raid from ${username} - get ready for RAID-BATTLE ${
                    (await getUserConfigOrDefaultValue(channelId, "enableChatCommands"))
                        ? "(type !RAIDBATTLE for info)"
                        : ""
                }`
            );
            handleBroadcastInterval(channelId);
            result = channelRaiders[channelId].data;
        } else console.log("[backend:897]: ERROR: no 'gamePackage' constructed");
        console.log(`[backend:906]: StartRaid returned: ${result == [] ? "Null" : "channelRaiders[channelId]"}:`);
        return result;
    } else {
        console.log("[backend:989]: RAIDER already has game: ", username);
        throw "[backend:989]: RAIDER already has game: " + username;
        return null;
    }
}
async function constructGamePackage(raiderUserName, raiderAmount, streamerData, channelId) {
    // constructs an object for a raid game
    const streamData = await getStreamsById(streamerData.channelId);
    if (streamData && streamData.type == "live") {
        const raiderUserData = await getUser(`login=${raiderUserName}`),
            raiderData = {
                channel_id: raiderUserData.id,
                display_name: raiderUserData.display_name,
                profile_image_url: raiderUserData.profile_image_url,
                viewers: raiderAmount,
            },
            gameTimeObj = await constructGameTimeObject(streamerData),
            gameResult = [];
        return {
            gameState: "running",
            raiderData,
            gameTimeObj,
            gameResult,
        };
    } else {
        console.log("[backend:919]: ERROR: streamData, is streamer live?:", streamData);
        return null;
    }
}
//! -------------------- RESULT -------------------- //
async function setGameExpiredResult(channelId) {
    // handles calculating the end game result when gameDuration is expired
    const channelRaidersData = channelRaiders[channelId].data,
        { streamerData, games: gamesArray } = channelRaidersData;

    if (gameExpired(gamesArray) && channelRaiders[channelId].hasRunningGame) {
        channelRaiders[channelId].hasRunningGame = false;
        channelRaiders[channelId].data.games.forEach((game) => (game.gameState = "result"));
        const raiders = gamesArray.map((game) => game.raiderData.display_name),
            raidersId = gamesArray.map((game) => game.raiderData.channel_id);
        let winner,
            defeated,
            stringToSend,
            draw = false;
        if (channelRaidersData.supportState > 5) {
            console.log("[backend:878]: GAME RESULT: streamer won!");
            //? streamer win
            defeated = raiders; //.length > 1 ? raiders.join(", ") : raiders[0];
            winner = streamerData.displayName;
            if (!channelRaiders[channelId].test) {
                await setStreamerBattleHistory({
                    channelId,
                    versus: defeated,
                    battleResult: BATTLE_HISTORY.win,
                    score: 1,
                });
                await setRaiderBattleHistory({
                    idArray: raidersId,
                    versus: [winner],
                    battleResult: BATTLE_HISTORY.lost,
                    score: 0,
                });
            }
        } else if (channelRaidersData.supportState < -5) {
            console.log("[backend:884]: GAME RESULT: raider(s) won!");
            //? raiders win
            winner = raiders; //.length > 1 ? raiders.join(", ") : raiders[0];
            defeated = streamerData.displayName;
            console.log("[backend:1051]: winner", winner);
            if (!channelRaiders[channelId].test) {
                await setStreamerBattleHistory({
                    channelId,
                    versus: winner,
                    battleResult: BATTLE_HISTORY.lost,
                    score: 0,
                });
                await setRaiderBattleHistory({
                    idArray: raidersId,
                    versus: [defeated],
                    battleResult: BATTLE_HISTORY.win,
                    score: 1,
                });
            }
        } else {
            console.log("[backend:891]: GAME RESULT: draw!");
            //? Draw
            winner = raiders; //.length > 1 ? raiders.join(", ") : raiders[0];
            defeated = streamerData.displayName;
            // raidersId.push(channelId);
            if (!channelRaiders[channelId].test) {
                await setStreamerBattleHistory({
                    channelId,
                    versus: winner,
                    battleResult: BATTLE_HISTORY.draw,
                    score: 1,
                });
                await setRaiderBattleHistory({
                    idArray: raidersId,
                    versus: [defeated],
                    battleResult: BATTLE_HISTORY.draw,
                    score: 1,
                });
            }
            draw = true;
        }
        stringToSend = `${winner} Gained more support than ${defeated}`;
        if (draw) stringToSend = `It was a draw between ${winner} and ${defeated}`;

        if (
            !gamesArray.some((game) => {
                return checkForExistingGameResult(game.gameResult, "string", stringToSend);
            })
        ) {
            setResult(channelId, raiders[0], stringToSend, "gameResultDuration");
            attemptSendChatMessageToChannel(streamerData, stringToSend);
        }

        // if (!checkForExistingGameResult(gamesArray[0].gameResult, "string", stringToSend)) {
        //     setResult(channelId, raiders[0], stringToSend, "gameResultDuration");
        //     streamerData = await dataBase.findOne({ channelId });
        //     attemptSendChatMessageToChannel(streamerData, stringToSend);
        // }
        streamStatusHandler({});
        sendFinalBroadcastTimeout(channelId);
    }
}
//! -------------------- HISTORY-DB -------------------- //
// update all docs with score + history before prod //! DEV
async function setStreamerBattleHistory(battleHistoryObj) {
    const { channelId, versus, battleResult, score } = battleHistoryObj;
    const result = await dataBase.updateOne(
        { channelId },
        {
            $inc: { score },
            $push: {
                battleHistory: {
                    $each: [
                        {
                            vs: versus,
                            result: battleResult,
                            date: new Date(), //2022-01-19T03:15:33.328+00:00
                        },
                    ],
                },
            },
        }
    );
    return result;
}
async function setRaiderBattleHistory(battleHistoryObj) {
    const { idArray, versus, battleResult, score } = battleHistoryObj;
    const result = await dataBase.updateMany(
        {
            channelId: {
                $in: idArray,
            },
        },
        {
            $inc: { score },
            $push: {
                battleHistory: {
                    $each: [
                        {
                            vs: versus,
                            result: battleResult,
                            date: new Date(),
                        },
                    ],
                },
            },
        }
    );
    return result;
}
function parseString(str) {
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

    // channelRaiders[channelId].data.games.forEach((game) => {
    //     if (game.raiderData.display_name.toLowerCase() == raider?.toLowerCase()) {
    //         const addedTime = await getUserConfigOrDefaultValue(channelId, durationName);
    //         const resultExpires = Date.now() + addedTime * 1000;
    //         raiderGame.gameResult.push({
    //             resultExpires,
    //             string,
    //         });
    //     }
    // });

    for (let i = 0; i < channelRaiders[channelId].data.games.length; i++) {
        const raiderGame = channelRaiders[channelId].data.games[i];
        if (raiderGame.raiderData.display_name.toLowerCase() == raider?.toLowerCase()) {
            const addedTime = await getUserConfigOrDefaultValue(channelId, durationName);
            const resultExpires = Date.now() + addedTime * 1000;
            raiderGame.gameResult.push({
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
    const gameDuration = Math.max(...gamesArray.map((game) => game.gameTimeObj.gameDuration));
    if (gameDuration >= Date.now() / 1000) {
        return false;
    }
    return true;
}
async function constructGameTimeObject(streamerData) {
    // handles creating the gameTimeObj: {gameDuration, introDuration, gameResultDuration}
    const introDuration = await calculateIntroDuration(streamerData),
        gameDuration = await calculateGameDuration(introDuration, streamerData),
        gameResultDuration = await getUserConfigOrDefaultValue(streamerData.channelId, "gameResultDuration");
    return { introDuration, gameDuration, gameResultDuration };
}
async function calculateIntroDuration(streamerData) {
    // set introDuration on gameTimeObj
    const introDuration = Math.floor(
        Date.now() / 1000 + (await getUserConfigOrDefaultValue(streamerData.channelId, "introDuration"))
    );
    return introDuration;
}
async function calculateGameDuration(introDuration, streamerData) {
    // set gameDuration on gameTimeObj
    // if there are more than 0 games in the list use extendGameDuration
    const userConfig = streamerData.userConfig;
    let gameDuration;
    if (channelRaiders[streamerData.channelId].games && channelRaiders[streamerData.channelId].games.length >= 1) {
        // using extendGameDuration if ongoing game
        const ongoingGame = Math.max(
            ...channelRaiders[streamerData.channelId].games.map((game) => game.gameTimeObj.gameDuration)
        );
        let extraTime = 0;
        if (userConfig && userConfig.extendGameDurationEnabled) {
            extraTime = await getUserConfigOrDefaultValue(streamerData.channelId, "extendGameDuration");
        }
        gameDuration = Math.floor(ongoingGame + extraTime);
    } else {
        // using streamerData if no other games are running
        // or DEFAULTS if no streamerData.userConfig
        gameDuration = Math.floor(
            introDuration + (await getUserConfigOrDefaultValue(streamerData.channelId, "gameDuration"))
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
    setGameExpiredResult(channelId);
    attemptRaidBroadcast(channelId);
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
        cooldown.trigger = setTimeout(sendRaidBroadcast, now - cooldown.time, channelId);
    }
}
//! ---- SEND ---- //
function formatGameData(channelId) {
    return JSON.stringify(channelRaiders[channelId].data);
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
        message: formatGameData(channelId),
        target: ["broadcast"],
    });
    // Send the broadcast request to the Twitch API.
    const url = "https://api.twitch.tv/helix/extensions/pubsub";
    try {
        const res = await fetch(url, { method: "POST", headers, body });
        if (res.status > 400) {
            console.log("[backend:1287]: ERROR:", res.status);
            // console.log("[backend:1288]: ERROR:", res.body);
            const jsondata = await res.json();
            console.log("[backend:1290]: ERROR:", jsondata);
        }
        console.log("[backend:503]: ", `Broadcasting to channelId: ${channelId}`, `Response: ${res.status}`);
    } catch (err) {
        console.log("[backend:1215]: ERROR:", err);
        //! limit is  5KiB! check size of data
    }
}
//! ---- SEND GLOBAL ---- //
async function sendGlobalBroadcast(dataToSend) {
    // Set the HTTP headers required by the Twitch API.
    const headers = {
        "Client-ID": clientId,
        "Content-Type": "application/json",
        Authorization: bearerPrefix + makeGlobalToken(),
    };
    // Create the POST body for the Twitch API request.
    const body = JSON.stringify({
        content_type: "application/json",
        is_global_broadcast: true,
        message: JSON.stringify({
            data: dataToSend,
            test: "ok",
        }),
        target: ["global"],
    });
    // Send the broadcast request to the Twitch API.
    const url = "https://api.twitch.tv/helix/extensions/pubsub";
    const res = await fetch(url, { method: "POST", headers, body });
    console.log("[backend:505]: ", `Broadcasting to ALL channels, Response: ${res.status}`);
}
//! ---- FINAL ---- //
async function sendFinalBroadcastTimeout(channelId) {
    if (!channelRaiders[channelId].finalBroadcastTimeout) {
        // sends a final broadcast after a timeOut(USER_CONFIG.gameResultDuration)
        const timeout = await getUserConfigOrDefaultValue(channelId, "gameResultDuration");
        console.log("[backend:713]:sending final broadcast in: ", timeout, " sec!");
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
            console.log("[backend:685]: cleaning up and sending final broadcast");
            clearInterval(channelRaiders[channelId].interval);
            channelRaiders[channelId].interval = null;
            channelRaiders[channelId].hasRunningGame = false;
            channelRaiders[channelId].finalBroadcastTimeout = null;
            channelRaiders[channelId].test = false;
            channelRaiders[channelId].data.games = [];
            channelRaiders[channelId].data.games.push("GAME OVER");
            channelRaiders[channelId].data.gameState = "GAME OVER";
            attemptRaidBroadcast(channelId);
            setTimeout(() => {
                channelRaiders[channelId] = "null";
            }, 2000);
        }
    } catch (err) {
        console.log("[backend:1317]: ERROR: ", err);
    }
}
//! --------------------------------------------------------- //
//*                       -- CHAT API --                     //
//! ------------------------------------------------------- //
function attemptSendChatMessageToChannel(streamerData, message) {
    // checks if USER_CONFIG.enableChatOutput is true and sends message
    if (streamerData.userConfig) {
        if (!streamerData.userConfig.enableChatOutput) {
            console.log("[backend:1282]: dont send message");
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
    console.log(`[backend:1321]: sending message: "${message}" to channel: "${channelId}"`);
    const jwtToken = makeServerToken(channelId);
    const url = `https://api.twitch.tv/helix/extensions/chat?broadcaster_id=${channelId}`,
        headers = {
            "Client-ID": clientId,
            Authorization: "Bearer " + jwtToken,
            "Content-Type": "application/json",
        },
        body = JSON.stringify({
            text: message,
            extension_id: clientId,
            extension_version: CURRENT_VERSION,
        });
    const res = await fetch(url, { method: "POST", headers, body });
    console.log(`[backend:1337]: Broadcast chat message result: ${res.status}: ${res.statusText}`);
}

//! --------------------------------------------------------- //
//*                   -- AUTHORIZATION --                    //
//! ------------------------------------------------------- //
function isUserConfirmed(req, res, next) {
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    res.locals.channelId = channelId;
    res.locals.opaqueUserId = opaqueUserId;
    // Bot abuse prevention:  don't allow a user to spam the button.
    if (userIsInCooldown(opaqueUserId)) {
        throw Boom.tooManyRequests(STRINGS.cooldown);
    }
    next();
}
function makeServerToken(channelId) {
    // Create and return a JWT for use by this service.
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
function makeGlobalToken() {
    // Create and return a JWT for use by this service.
    // makes a JWT token
    const payload = {
        exp: Math.floor(Date.now() / 1000) + serverTokenDurationSec,
        user_id: ownerId, // extension owner ID for the call to Twitch PubSub
        role: "external",
        channel_id: "all",
        pubsub_perms: {
            send: ["global"],
        },
    };
    return jsonwebtoken.sign(payload, secret, { algorithm: "HS256" });
}
function verifyAndDecode(header) {
    // Verify the header and the enclosed JWT.
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
function userIsInCooldown(opaqueUserId, skipCooldown = false) {
    // Check if the user is in cool-down.
    const cooldown = userCooldowns[opaqueUserId];
    const now = Date.now();
    if (cooldown && cooldown > now) {
        return true;
    }
    // Voting extensions must also track per-user votes to prevent skew.
    userCooldowns[opaqueUserId] = now + skipCooldown ? userSkipCooldownMs : userCooldownMs;
    return false;
}
//! ------ confirm user ------ //
function confirmOpaqueUser(req, res, next) {
    if (parseInt(res.locals.channelId) === parseInt(res.locals.opaqueUserId.replace("U", ""))) {
        return next();
    }
    throw Boom.unauthorized(STRINGS.invalidAuthHeader);
}

//RUN ONCE:

async function setEventsubOnAll() {
    // let result = await dataBase.find({});

    missed_reg = [766436971, 181462072, 178854251, 223433138];
    missed_reg.forEach(async (userId, i) => {
        console.log("[backend:1433]: user", userId);

        setTimeout(async () => {
            const response = await addNewStreamer(userId);
            console.log("[backend:1439]: response", response);
        }, i * 5000);

        console.log("[backend:1433]: ----------------- ");
    });

    // console.log("[backend:1452]: result", result);

    // const appToken = await getAppAccessToken();
    // const eventSubs = await getEventSubEndpoint(appToken);

    // result.forEach(async (user, i) => {
    //     const channelEsubs = eventSubs.filter((eSub) => {
    //         const eSubChannelId = eSub.condition.to_broadcaster_user_id || eSub.condition.broadcaster_user_id;
    //         return eSubChannelId === user.channelId;
    //     });
    //     const DBresult = await dataBase.updateOne({ channelId: user.channelId }, { $set: { eventSUb: channelEsubs } });
    //     if (channelEsubs.length < 3) {
    //         console.log(
    //             `[backend:1455]: CURRENT USER: ${i + 1} / ${result.length}\n
    //         channelEsubs: ${channelEsubs.length === 3 ? channelEsubs.length : user.channelId},\n
    //         DBresult:
    //         `,
    //             DBresult,
    //             "---------------------"
    //         );
    //     }
    // });

    // console.log("[backend:1436]: eventSubs", eventSubs);
    // console.log("[backend:1436]: eventSubs", eventSubs.length);

    // eventSubs.data.forEach((eSub) => {
    //     if (eSub) {
    //     }
    // });

    // result.forEach(async (user) => {
    //     try {
    //         // const repsonse = await checkEventSubUser(user.channelId);

    //         const result = await dataBase.updateOne({ channelId: user.channelId }, { $set: { eventSub: repsonse } });
    //         console.log("[backend:1439]: result", result);
    //     } catch (err) {
    //         console.log("[backend:1439]: err:", err);
    //     }
    // });
    //! --------------------  -------------------- //

    // const new_result = result.map((user) => {
    //     const { channelName, displayName, channelId, profilePicUrl, userConfig, eventSub } = u
    //     let newSub;
    //     console.log("[backend:1436]: eventSub", eventSub);
    //     eventSub?.forEach((eSub) => {
    //         if (eSub.registeredEventSub.length === 3) newSub = eSub[0];
    //     });
    //     return { channelName, displayName, channelId, profilePicUrl, userConfig, eventSub: newSub };
    // });
    // new_result.forEach((user, i) => {
    //     setTimeout(async () => {
    //         const result = await dataBase.updateOne({ channelId: user.channelId }, { $set: user });
    //         console.log("[backend:1443]: result", result);
    //     }, i * 1000);
    // });
    // console.log("[backend:1431]: result", result);
}
