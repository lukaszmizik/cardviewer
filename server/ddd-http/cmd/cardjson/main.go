package main

import (
	"encoding/json"
	"fmt"
	"os"

	"tacho-viewer/ddd-http/parse"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "použití: cardjson <soubor.ddd|.esm|.561>")
		os.Exit(2)
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	card, err := parse.Card(data)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(card); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
