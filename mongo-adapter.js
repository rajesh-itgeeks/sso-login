import { MongoClient } from "mongodb";

let db;
async function getDB() {
  if (!db) {
    const client = await MongoClient.connect("mongodb+srv://rajeshchoudhary:PSm1F16U62R4maV6@cluster0.xbw5huk.mongodb.net/oidc");
    db = client.db();
  }
  return db;
}

export class MongoAdapter {
  constructor(name) {
    this.name = name;
  }

  async upsert(_id, payload, expiresIn) {
    const db = await getDB();
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
    await db.collection(this.name).updateOne(
      { _id },
      { $set: { payload, expiresAt } },
      { upsert: true }
    );
  }

  async find(_id) {
    const db = await getDB();
    const doc = await db.collection(this.name).findOne({ _id });
    return doc?.payload;
  }

  async destroy(_id) {
    const db = await getDB();
    await db.collection(this.name).deleteOne({ _id });
  }

  async consume(_id) {
    const db = await getDB();
    await db.collection(this.name).updateOne({ _id }, { $set: { "payload.consumed": true } });
  }
}
