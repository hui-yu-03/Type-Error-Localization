var p = new Promise(function (res, rej) {
  rej("error");
});

var results = Promise.all([Promise.resolve(1), p]);
