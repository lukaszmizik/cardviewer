package main

import (
	"encoding/json"
	"syscall/js"

	"tacho-viewer/ddd-http/parse"
)

func main() {
	js.Global().Set("dddParseCard", js.FuncOf(parseCard))
	js.Global().Set("dddParserReady", js.ValueOf(true))
	select {}
}

func parseCard(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return map[string]any{"ok": false, "error": "chybí data karty"}
	}
	src := args[0]
	length := src.Get("byteLength")
	n := 0
	if length.Type() == js.TypeNumber {
		n = length.Int()
	} else {
		n = src.Get("length").Int()
	}
	if n <= 0 {
		return map[string]any{"ok": false, "error": "prázdný soubor"}
	}
	buf := make([]byte, n)
	js.CopyBytesToGo(buf, src)

	card, err := parse.Card(buf)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	out, err := json.Marshal(card)
	if err != nil {
		return map[string]any{"ok": false, "error": "nelze zapsat JSON"}
	}
	return map[string]any{"ok": true, "json": string(out)}
}
