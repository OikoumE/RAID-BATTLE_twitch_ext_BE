// File: app.mjs - EventSub WebHooks
// Author: itsOiK
// Date: 07/01-22

import fetch from "node-fetch";
import crypto from "crypto";

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
const EVENTSUB_ENDPOINT = "https://api.twitch.tv/helix/eventsub/subscriptions";

const CLIENT_ID = process.env.APP_CLIENT_ID,
    CLIENT_SECRET = process.env.APP_CLIENT_SECRET,
    APP_ACCESS_TOKEN = process.env.APP_ACCESS_TOKEN,
    EVENTSUB_SUBSCRIPTION_SECRET = process.env.EVENTSUB_SUBSCRIPTION_SECRET;

export function webhookCallback(req, res, callback) {
    let message = getHmacMessage(req);
    let hmac = HMAC_PREFIX + getHmac(EVENTSUB_SUBSCRIPTION_SECRET, message); // Signature to compare
    if (true === verifyMessage(hmac, req.headers[TWITCH_MESSAGE_SIGNATURE])) {
        console.log("[app:74]: signatures match");
        // Get JSON object from body, so you can process the message.
        let notification = JSON.parse(req.body);
        if (MESSAGE_TYPE_NOTIFICATION === req.headers[MESSAGE_TYPE]) {
            // TODO: Do something with the event's data.
            console.log(`[app:79]: Event type: ${notification.subscription.type}`);
            console.log(`[app:80]: ${JSON.stringify(notification.event, null, 4)}`);
            // TODO add callback for event notifications
            callback(notification);
            res.sendStatus(204);
        } else if (MESSAGE_TYPE_VERIFICATION === req.headers[MESSAGE_TYPE]) {
            res.status(200).send(notification.challenge);
        } else if (MESSAGE_TYPE_REVOCATION === req.headers[MESSAGE_TYPE]) {
            res.sendStatus(204);
            console.log(`${notification.subscription.type} notifications revoked!`);
            console.log(`reason: ${notification.subscription.status}`);
            console.log(`condition: ${JSON.stringify(notification.subscription.condition, null, 4)}`);
        } else {
            res.sendStatus(204);
            console.log(`Unknown message type: ${req.headers[MESSAGE_TYPE]}`);
        }
    } else {
        console.log("403"); // Signatures didn't match.
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

export async function getEventSubEndpoint() {
    const headers = {
        Authorization: `Bearer ` + APP_ACCESS_TOKEN,
        "Client-Id": CLIENT_ID,
    };
    const result = await fetch(EVENTSUB_ENDPOINT, { headers });
    const result_json = await result.json();
    console.log("[app:159]: result_json", result_json);
    return result_json;
}

export async function EventSubRegister(to_broadcaster_user_id) {
    const subscriptionData = {
        version: "1",
        type: "channel.raid",
        condition: {
            to_broadcaster_user_id: to_broadcaster_user_id,
        },
        transport: {
            method: "webhook",
            callback: "https://raid-battle-twitch-ext.herokuapp.com/" + EVENTSUB_ENDPOINT_PATH,
            // callback: "https://itsoik-eventsub.herokuapp.com/webhook/callback", //TODO change this
            secret: EVENTSUB_SUBSCRIPTION_SECRET,
        },
    };
    const _result = await postEventSubEndpoint(subscriptionData);
    console.log("[app:128]: _result", _result);
    // res.status(200).send(return200()); //TODO change this
    return _result;
}

async function postEventSubEndpoint(body) {
    const headers = {
        Authorization: `Bearer ` + APP_ACCESS_TOKEN,
        "Client-Id": CLIENT_ID,
        "Content-type": "application/json",
    };
    const data = {
        headers,
        body: JSON.stringify(body),
        method: "POST",
    };
    const result = await fetch(EVENTSUB_ENDPOINT, data);
    const result_json = await result.json();
    console.log("[app:144]: result_json", result_json);
    return result_json;
}
