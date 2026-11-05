/**
 * 
 * var obj = {};
obj.count = 0;
var count = obj.count;
var next  = count + 1;
obj.count = next;
 */

var person = {};
//person.name = "Ada";
person.age = 36;

//var n = person.name;

var a = person.age;

var b = a;

function greet() {
  //var a = person.age;
  //var combined = a + 1;
}

//有问题
// TODO: Last part of the logic left, when the types are not calculated deterministiclly, we have to decide the final type....
