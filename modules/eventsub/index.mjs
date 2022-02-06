// File: app.mjs - EventSub WebHooks
// Author: itsOiK
// Date: 07/01-22

import { URL, URLSearchParams } from "url";
import fetch from "node-fetch";
import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config();

// Notification request headers
const TWITCH_MESSAGE_ID = "Twitch-Eventsub-Message-Id".toLowerCase();
const TWITCH_MESSAGE_TIMESTAMP = "Twitch-Eventsub-Message-Timestamp".toLowerCase();
const TWITCH_MESSAGE_SIGNATURE = "Twitch-Eventsub-Message-Signature".toLowerCase();
const MESSAGE_TYPE = "Twitch-Eventsub-Message-Type".toLowerCase();

// Notification message types
const MESSAGE_TYPE_VERIFICATION = "webhook_callback_verification";
const MESSAGE_TYPE_NOTIFICATION = "notification";
const MESSAGE_TYPE_REVOCATION = "revocation";

// Prepend this string to the HMAC that's created from the message
const HMAC_PREFIX = "sha256=";
const EVENTSUB_ENDPOINT = "https://api.twitch.tv/helix/eventsub/subscriptions",
    EVENTSUB_ENDPOINT_PATH = process.env.EVENTSUB_ENDPOINT_PATH;

const APP_CLIENT_ID = process.env.APP_CLIENT_ID,
    APP_CLIENT_SECRET = process.env.APP_CLIENT_SECRET,
    APP_ACCESS_TOKEN = process.env.APP_ACCESS_TOKEN,
    EVENTSUB_SUBSCRIPTION_SECRET = process.env.EVENTSUB_SUBSCRIPTION_SECRET;

export async function webhookCallback({ req, res, callbackObj }) {
    const { startRaid, addNewStreamer, deleteEventSubEndpoint, streamStatusHandler } = callbackObj;
    let message = getHmacMessage(req);
    let hmac = HMAC_PREFIX + getHmac(EVENTSUB_SUBSCRIPTION_SECRET, message); // Signature to compare
    if (true === verifyMessage(hmac, req.headers[TWITCH_MESSAGE_SIGNATURE])) {
        console.log("[index:74]: signatures match");
        // Get JSON object from body, so you can process the message.
        let notification = JSON.parse(req.body);
        const channelId =
                notification.subscription.condition.broadcaster_user_id ||
                notification.subscription.condition.to_broadcaster_user_id,
            eventType = notification.subscription.type;
        if (MESSAGE_TYPE_NOTIFICATION === req.headers[MESSAGE_TYPE]) {
            console.log(`[index:79]: Event type: ${eventType}`);
            console.log(`[index:80]: ${JSON.stringify(notification.event, null, 4)}`);
            if (eventType === "channel.raid") {
                const channel = notification.event.to_broadcaster_user_name,
                    username = notification.event.from_broadcaster_user_login,
                    viewers = notification.event.viewers;
                await startRaid({ channel, username, viewers });
            } else if (eventType === "user.authorization.revoke") {
                await deleteEventSubEndpoint(channelId);
            } else if (eventType === "channel.offline" || eventType === "channel.online") {
                await streamStatusHandler(notification.event);
            }
            res.sendStatus(204);
        } else if (MESSAGE_TYPE_VERIFICATION === req.headers[MESSAGE_TYPE]) {
            // here
            res.status(200).send(notification.challenge);
            await addNewStreamer(channelId, true);
        } else if (MESSAGE_TYPE_REVOCATION === req.headers[MESSAGE_TYPE]) {
            console.log(`[index:60]: ${eventType} notifications revoked!`);
            console.log(`[index:60]: reason: ${notification.subscription.status}`);
            console.log(`[index:60]: condition: ${JSON.stringify(notification.subscription.condition, null, 4)}`);
            res.sendStatus(204);
        } else {
            console.log(`[index:65]: Unknown message type: ${req.headers[MESSAGE_TYPE]}`);
            res.sendStatus(204);
        }
    } else {
        console.log("[index:70]: 403"); // Signatures didn't match.
        res.sendStatus(403);
    }
}

// Build the message used to get the HMAC.
function getHmacMessage(request) {
    return request.headers[TWITCH_MESSAGE_ID] + request.headers[TWITCH_MESSAGE_TIMESTAMP] + request.body;
}

// Get the HMAC.
function getHmac(secret, message) {
    return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

// Verify whether our hash matches the hash that Twitch passed in the header.
function verifyMessage(hmac, verifySignature) {
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(verifySignature));
}

export async function getEventSubEndpoint(appToken, page = null, previousResponse = []) {
    const headers = {
        Authorization: `Bearer ${appToken}`,
        "Client-Id": APP_CLIENT_ID,
    };
    const urlSearchParams = { status: "enabled" };
    if (page) urlSearchParams["after"] = page;
    const url = new URL(EVENTSUB_ENDPOINT);
    url.search = new URLSearchParams(urlSearchParams).toString();
    return fetch(url, { headers })
        .then((response) => response.json())
        .then(async (newResponse) => {
            if (newResponse.data) {
                const response = [...previousResponse, ...newResponse.data]; // Combine the two arrays
                if (newResponse.pagination && newResponse.data.length == 100) {
                    console.log("[backend:315]: doing pagination");
                    return await getEventSubEndpoint(appToken, newResponse.pagination.cursor, response);
                }
                return response;
            }
            return newResponse;
        })
        .catch((err) => {
            console.log("[backend:311]: ERROR: ", err);
        });
    // const result = await fetch(EVENTSUB_ENDPOINT, { headers });
    // const result_json = await result.json();

    // if (result_json.status > 200) {
    //     const error = `[index:97]: ERROR: ${result_json}`;
    //     console.log("[index:95]: ERROR:", error);
    //     throw error;
    // }
    // return result_json;
}

export async function EventSubRegister(broadcaster_user_id, eventArray) {
    console.log("[index:120]: broadcaster_user_id", broadcaster_user_id);
    if (broadcaster_user_id) {
        eventArray.forEach(async (event, i) => {
            const subscriptionData = {
                version: "1",
                type: event,
                condition: {},
                transport: {
                    method: "webhook",
                    callback: "https://raidbattle.herokuapp.com/" + EVENTSUB_ENDPOINT_PATH,
                    secret: EVENTSUB_SUBSCRIPTION_SECRET,
                },
            };
            if (i === 0) {
                subscriptionData.condition["to_broadcaster_user_id"] = `${broadcaster_user_id}`;
            } else {
                subscriptionData.condition["broadcaster_user_id"] = `${broadcaster_user_id}`;
            }
            setTimeout(async () => {
                console.log("[index:125]: subscriptionData", subscriptionData.condition);
                const _result = await postEventSubEndpoint(subscriptionData);
                console.log("[index:149]: _result", _result);
                if (Object.keys(_result).includes(data)) {
                    console.log(
                        "[index:125]: postEventSubEndpoint request added: ",
                        _result.data[0].status === "webhook_callback_verification_pending",
                        _result.data[0].type
                    );
                }
            }, i * 1000);
        });
    }
    return;
}

async function postEventSubEndpoint(body) {
    const headers = {
        Authorization: `Bearer ` + APP_ACCESS_TOKEN,
        "Client-Id": APP_CLIENT_ID,
        "Content-type": "application/json",
    };
    const data = {
        headers,
        body: JSON.stringify(body),
        method: "POST",
    };
    const result = await fetch(EVENTSUB_ENDPOINT, data);
    const result_json = await result.json();
    return result_json;
}

//! --------------------------------------------------------- //
//*                      -- DO ONCE --                       //
//! ------------------------------------------------------- //

async function registerRevokeAccessEventSub() {
    //! this is for noticing if a user revokes ext auth scopes
    //! dont have scopes yet........
    const subscriptionData = {
        version: "1",
        type: "user.authorization.revoke",
        condition: {
            client_id: APP_CLIENT_ID,
        },
        transport: {
            method: "webhook",
            callback: "https://raidbattle.herokuapp.com/" + EVENTSUB_ENDPOINT_PATH,
            secret: EVENTSUB_SUBSCRIPTION_SECRET,
        },
    };
    const _result = await postEventSubEndpoint(subscriptionData);
    // console.log("[index:128]: _result", _result);
    return _result;
}
