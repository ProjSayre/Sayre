/* Fixture: a base class, a subclass (extends), a top-level named arrow
 * function const, and a method calling a sibling method — exercises
 * ParsedClass/ParsedInheritance, ParsedFunction (both function_declaration
 * and named arrow-const forms), and this.method() calls. */

class Shape {
  area() {
    return 0;
  }
}

class Circle extends Shape {
  constructor(radius) {
    super();
    this.radius = radius;
  }

  area() {
    return this.computeArea();
  }

  computeArea() {
    return 3.14159 * this.radius * this.radius;
  }
}

function describe(shape) {
  return shape.area();
}

const makeCircle = (radius) => {
  return new Circle(radius);
};

module.exports = { Shape, Circle, describe, makeCircle };
