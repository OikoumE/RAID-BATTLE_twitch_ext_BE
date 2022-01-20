// File: database.mjs - Description
// Author: itsOiK
// Date: 09/01-22
import { MongoClient } from "mongodb";
import { ObjectId } from "mongodb";
//! --------------------------------------------------------- //
//*                       -- DATABASE --                     //
//! ------------------------------------------------------- //
export class DataBase {
    // class for handling all database functions
    constructor() {
        console.log("[database:11]: Database init");
        this.client = new MongoClient(process.env.MONGODB_URL, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        this.dataBaseName = "RaidBattle";
        this.collection = "TEST_COLLECTION"; //! dev CHANGE BEFORE PROD!
    }
    async connect() {
        try {
            await this.client.connect();
        } catch (e) {
            console.log("[database:276]: e", e);
        }
    }
    async insertOne(document, collection = this.collection) {
        const result = await this.client.db(this.dataBaseName).collection(collection).insertOne(document);
        if (result) {
            console.log(`[database:287]: new db entry added at`, result.insertedId);
            return result;
        }
        console.log(`[database:293]: no documents added:`, result);
    }
    async findOne(document, collection = this.collection) {
        const result = await this.client.db(this.dataBaseName).collection(collection).findOne(document);
        if (result) {
            return result;
        }
        console.log(`[database:301]: no document found with document:`, document);
    }
    async find(document = {}, collection = this.collection) {
        const result = await this.client.db(this.dataBaseName).collection(collection).find(document).toArray();
        if (result) {
            return result;
        }
        console.log(`[database:302]: no documents found:`, result);
    }
    async updateOne(filterDocument, updateDocument, collection = this.collection) {
        const result = await this.client
            .db(this.dataBaseName)
            .collection(collection)
            .updateOne(filterDocument, updateDocument, { upsert: false });
        return result;
    }
    async updateMany(filterDocument, updateDocument, collection = this.collection) {
        const result = await this.client
            .db(this.dataBaseName)
            .collection(collection)
            .updateMany(filterDocument, updateDocument, { upsert: false });
        return result;
    }
    async checkIfUserInDb(channelId, collection = this.collection) {
        const result = await this.find({ channelId }, collection);
        for (const document of result) {
            if (document.channelId == channelId) {
                return true;
            }
        }
        return false;
    }
}
