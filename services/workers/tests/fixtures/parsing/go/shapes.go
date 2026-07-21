// Fixture: a struct with a pointer-receiver method and a value-receiver
// method (enclosing_class = receiver type name either way), a module-level
// function, grouped/aliased imports, and a call between a function and a
// method — exercises ParsedFunction (incl. receiver handling) and
// ParsedImport (grouped + aliased), and confirms classes/inherits stay
// empty for Go.

package shapes

import (
	"fmt"
	m "math"
)

type Circle struct {
	Radius float64
}

func (c *Circle) Area() float64 {
	return m.Pi * c.Radius * c.Radius
}

func (c Circle) Describe() string {
	return fmt.Sprintf("circle r=%v", c.Radius)
}

func NewCircle(radius float64) *Circle {
	c := &Circle{Radius: radius}
	fmt.Println(c.Describe())
	return c
}
