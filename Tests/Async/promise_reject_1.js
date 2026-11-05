var a = Promise.reject("something went wrong");

var p = new Promise(function (res, rej) {
  rej("oops");
});

var b = Promise.reject(p);
