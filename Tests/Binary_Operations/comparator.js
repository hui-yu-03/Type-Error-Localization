var x = 10;
var y = 20;
var cmp = x < y;
var cmp2 = 33 > 2;

if (cmp) {
  var result = 1;
} else {
  var result = 0;
}

function add(a, b) {
  var x = a + b;
  var cmp = x === a + b;
  return x;
}

// var a = add(1, 1); not rule for function application
