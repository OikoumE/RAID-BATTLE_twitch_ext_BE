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

// TODO reset health after X time
// TODO end game state
// TODO when all raiders are dead
// TODO timer, add to timer if new raid during game
// TODO sending gameOverState: win/defeated raiderX/loose

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
const userCooldownMs = 250; // maximum input rate per user to prevent bot abuse
const userCooldownClearIntervalMs = 60000; // interval to reset our tracking object
const channelCooldownMs = 1000; // maximum broadcast rate per channel
const bearerPrefix = "Bearer "; // HTTP authorization headers have this prefix
const channelCooldowns = {}; // rate limit compliance
let userCooldowns = {}; // spam prevention
const { resolveObjectURL } = require("buffer");
const { get } = require("https");

//! -------------------- my vars -------------------- //
const tmi = require("tmi.js");
const fetch = require("node-fetch");

const initialHealth = 100;
const channelRaiders = {};
var channelsToJoin = [],
    channelIds = {},
    channelNames = {};
var tmiClient;
var healthModifier = 1;
//! -------------------- my vars -------------------- //

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
    host: "localhost",
    port: process.env.PORT || 80,
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
function onLaunch() {
    //this is ran when server starts up
    console.log("Server starting");
    const data = readJsonFile(streamersFilePath);
    channelsToJoin = data.channels;
    channelIds = data.channelIds;
    startTmi(data.channels);
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
        handler: addNewStreamerHandler, //
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
    console.log(STRINGS.serverStarted, server.info.uri);
    // Periodically clear cool-down tracking to prevent unbounded growth due to
    // per-session logged-out user tokens.
    setInterval(() => {
        userCooldowns = {};
    }, userCooldownClearIntervalMs);
    onLaunch();
})();

function return404(req) {
    return "404";
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
//*                   -- FILE HANDLERs --                    //
//! ------------------------------------------------------- //
const streamersFilePath = "./streamers.json";
function addStreamerAndWriteFile(streamer, channelId) {
    const dataFromFile = readJsonFile(streamersFilePath);
    channelsToJoin = dataFromFile.channels;
    channelIds = dataFromFile.channelIds;
    channelNames = dataFromFile.channelNames;
    if (!channelsToAdd.some((item) => item === streamer)) {
        channelsToJoin.push(streamer);
        channelIds[channelId] = streamer;
        channelNames[streamer] = `${channelId}`;
        const dataToWrite = {
            channels: channelsToJoin,
            channelIds: channelIds,
            channelNames: channelNames,
        };
        writeJsonFile(streamersFilePath, dataToWrite);
        return dataToWrite.channels;
    } else {
        console.error("streamer already in list");
        return false;
    }
}

function readJsonFile(path) {
    try {
        const data = fs.readFileSync(path, "utf8");
        // console.log(JSON.parse(data));
        return JSON.parse(data);
    } catch (err) {
        console.error(err);
    }
}

function writeJsonFile(path, payload) {
    let data = JSON.stringify(payload);
    fs.writeFile(path, data, (err) => {
        if (err) throw err;
        console.log("Data written to file");
    });
}

//! --------------------------------------------------------- //
//*                   -- ROUTE HANDLERS --                   //
//! ------------------------------------------------------- //

function ongoingRaidGameQueryHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    console.log(channelId);
    console.log(
        "[backend:240]: channelRaiders[channelId]",
        channelRaiders[channelId]
    );
    console.log("[backend:240]: channelRaiders", channelRaiders);
    if (
        !Array.isArray(channelRaiders[channelId]) //|| channelRaiders[channelId].length == 0
    ) {
        console.log("No active games");
        return null;
    }
    return channelRaiders[channelId];
}

function addNewStreamerHandler(req) {
    // Verify all requests.
    const payload = verifyAndDecode(req.headers.authorization);
    const { channel_id: channelId, opaque_user_id: opaqueUserId } = payload;
    const channelName = getUserById(channelId);
    const result = addStreamerAndWriteFile(channelName, channelId);
    if (result) {
        const newChannelList = result;
        if (tmiClient) {
            tmiClient.disconnect();
        } else {
            console.error("no tmi connected??");
        }
        tmiClient.on("disconnected", (reason) => {
            console.error(reason);
            startTmi(newChannelList);
        });
    }
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
                console.log(STRINGS.messageSendError, channelId, err);
            } else {
                verboseLog(STRINGS.pubsubResponse, channelId, res.statusCode);
            }
        }
    );
}

//! --------------------------------------------------------- //
//*                       -- TMI.JS --                       //
//! ------------------------------------------------------- //
async function getUserById(id) {
    // Check user map first.
    // Query Twitch for user details.
    const url = `https://api.twitch.tv/kraken/users/${id}`;
    const headers = {
        Accept: "application/vnd.twitchtv.v5+json",
        "Client-ID": "cr20njfkgll4okyrhag7xxph270sqk", //! REPLACE WITH OWN CLIENT ID MADE FOR EXT ONLY!
    };
    // Handle response.
    let response = await fetch(url, { headers });
    if (response.ok) {
        let data = await response.json();
        console.log("User for id " + id + " found: " + data.display_name);
        return data.display_name;
    }
}

async function getUserPicUrl(user) {
    return await fetch(`https://decapi.me/twitch/avatar/${user}`).then(
        async (result) => {
            return await result.text();
        }
    );
}

async function getCurrentViewerAmount(channel) {
    return await fetch(`https://decapi.me/twitch/viewercount/${channel}`).then(
        async (result) => {
            return await result.text();
        }
    );
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

function startTmi(channels) {
    tmiClient = new tmi.Client({
        connection: {
            secure: true,
            reconnect: true,
        },
        channels: channels,
    });
    tmiClient.connect().then(() => {
        console.log(`Listening for messages on ${channels}`);
    });
    tmiClient.on("raided", (channel, username, viewers) => {
        // channel: String - Channel name being raided
        // username: String - Username raiding the channel
        // viewers: Integer - Viewers count
        console.log(
            `${channel} was raided by: ${username} with ${viewers} viewers`
        );
        channel = channel.replace("#", "");
        viewers = parseInt(viewers);

        startRaid(channel, username, viewers);
    });
}

function startRaid(channel, username, viewers) {
    console.log(
        `Starting raid on channel: ${channel}, started by: ${username}`
    );
    const channelId = channelIds[channel];

    (async () => {
        const currentViewers = await getCurrentViewerAmount(channel),
            raiderPicUrl = await getUserPicUrl(username),
            streamerPicUrl = await getUserPicUrl(channel),
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
        //!
        if (!Array.isArray(channelRaiders[channelId])) {
            channelRaiders[channelId] = [];
            console.warn("made array");
        }
        if (
            !channelRaiders[channelId].some((item) => item.raider === username)
        ) {
            channelRaiders[channelId].push(raidPackage);
            console.warn("added raidObj");
        }
        attemptRaidBroadcast(channelId);
    })();
    if (channelRaiders[channelId]) {
        return channelRaiders[channelId];
    } else {
        return null;
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
function sendRaidBroadcast(channelId) {
    // Set the HTTP headers required by the Twitch API.
    const headers = {
        "Client-ID": clientId,
        "Content-Type": "application/json",
        Authorization: bearerPrefix + makeServerToken(channelId),
    };
    console.log(
        "[backend:526]: channelRaiders[channelId]",
        channelRaiders[channelId]
    );
    console.log("[backend:525]: channelRaiders", channelRaiders);
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
    // TODO start counting down when game start
    // TODO attempt broadcast every second with updated TIMELEFT if game is still running
    // TODO when game end send final broadcast to end game on frontend and clean up
    //TODO setInterval broadcast every sec for timer update!
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
