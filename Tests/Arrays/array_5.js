// Array destructuring: element bindings get the array's element type.
var parts = ["hello", "world"];
var [first, second] = parts;

// Destructuring from a method return (split returns Array<str>).
var str = "a:b:c";
var [head] = str.split(":");
