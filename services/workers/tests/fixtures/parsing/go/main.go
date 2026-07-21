// Fixture: a single (non-grouped) import, blank + dot imports, and a
// module-level function calling into shapes.go's exported constructor.

package main

import "fmt"
import _ "net/http/pprof"
import . "os"

func main() {
	circle := NewCircle(2.0)
	fmt.Println(Getenv("HOME"), circle)
}
