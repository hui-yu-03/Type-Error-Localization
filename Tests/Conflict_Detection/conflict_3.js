// x__global <= num  AND  x__global <= {label: T_str} -> conflict

var a = 3;
var b = 7;
var x = a + b;

x.label = "tag";

var y = x.label;

// TODO: what happens to y?
