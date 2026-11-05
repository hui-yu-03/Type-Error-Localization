function Animal(name, sound) {
  this.name = name;
  this.sound = sound;
}

Animal.prototype.speak = function () {
  return this.sound;
};

Animal.prototype.describe = function () {
  return this.name + " says " + this.speak();
};

var a = new Animal("cat", "meow");
var s = a.describe();
