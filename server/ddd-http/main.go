package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"

	"github.com/traconiq/tachoparser/pkg/decoder"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /parse-card", handleParseCard)
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	addr := "127.0.0.1:8787"
	log.Printf("dddparser HTTP naslouchá na http://%s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

func handleParseCard(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "nelze přečíst tělo požadavku", http.StatusBadRequest)
		return
	}
	if len(data) == 0 {
		http.Error(w, "prázdný soubor", http.StatusBadRequest)
		return
	}

	card, err := parseCardBytes(data)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(card); err != nil {
		http.Error(w, "nelze zapsat JSON", http.StatusInternalServerError)
	}
}

func parseCardBytes(data []byte) (*decoder.Card, error) {
	candidates := [][]byte{data}
	if len(data) > 2 && data[0] == 0x76 && data[1] == 0x06 {
		candidates = append(candidates, data[2:])
	}

	var lastErr error
	for _, payload := range candidates {
		var card decoder.Card
		if _, err := decoder.UnmarshalTLV(payload, &card); err != nil {
			lastErr = err
			continue
		}
		return &card, nil
	}
	return nil, fmt.Errorf("soubor se nepodařilo zpracovat jako kartu řidiče: %v", lastErr)
}
