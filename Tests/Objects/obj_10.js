var counter = {};
counter.val = 0;

function increment() {
  var cur = counter.val;
  var next = cur + 1;
  counter.val = next;
}

var final = counter.val;

//TODO: bot
