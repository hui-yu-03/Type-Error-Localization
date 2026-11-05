var a = 1;
var b = 2;
var c = 3;
var d = 4;

var s1 = a + b;
var s2 = s1 + c;
var s3 = s2 + d;
var s4 = s3 + 0;

var obj = {};
obj.total = s4;

var check = obj.total + 1;
