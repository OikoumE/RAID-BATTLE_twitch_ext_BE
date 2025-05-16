let error = false;

db.LatestNews.drop();
db.LatestNews.insert({
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
});

db.users.drop();
db.users.createIndex({ channelId: 1 }, { unique: true });
db.users.createIndex({ channelName: 1 }, { unique: true });
