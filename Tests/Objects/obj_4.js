var obj1 = {};
obj1.data = 100;

var obj2 = {};
var shared = obj1.data;
obj2.data = shared;

var result = obj2.data + 1;

//TODO: bot
