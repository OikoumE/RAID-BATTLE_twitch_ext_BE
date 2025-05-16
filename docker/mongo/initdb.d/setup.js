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

// let res = [
//   db.container.drop(),
//   db.container.createIndex({ myfield: 1 }, { unique: true }),
//   db.container.createIndex({ thatfield: 1 }),
//   db.container.createIndex({ thatfield: 1 }),
//   db.container.insert({ myfield: 'hello', thatfield: 'testing' }),
//   db.container.insert({ myfield: 'hello2', thatfield: 'testing' }),
//   db.container.insert({ myfield: 'hello3', thatfield: 'testing' }),
//   db.container.insert({ myfield: 'hello3', thatfield: 'testing' })
// ]

// printjson(res)

// if (error) {
//   print('Error, exiting')
//   quit(1)
// }
