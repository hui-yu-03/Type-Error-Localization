var data = {};
data.x = 1;

var store = {};
store.log = 0;

function outer(data) {
  var local = data;

  function inner() {
    var cur = store.log;
    store.log = cur + 1;
  }

  var check = store.log;
}

//TODO: problem of solver due to property read store.log
