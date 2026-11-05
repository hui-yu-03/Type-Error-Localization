// x is num and object -> conflict
// y is num and object -> conflict

var a = 10;
var b = 20;
var x = a + b;
x.label = "oops";

var y = 5;
y.p = "test";
var hui = y + y.p;
