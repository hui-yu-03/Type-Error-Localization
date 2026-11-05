class Animal {
  constructor(name, age) {
    this.name = name;
    this.age = age;
  }

  cry() {
    return "crying";
  }
}

class Dog extends Animal {
  constructor(name, age, specie) {
    super(name, age);
    this.specie = specie;
  }

  set_weight(weight) {
    this.weight = weight;
  }
}

const d = new Dog("Rex", 3, "bulldog");

d.place_of_birth = "China";
d.set_weight(30);

//console.log(d);

