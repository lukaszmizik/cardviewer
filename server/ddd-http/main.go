package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"

	"tacho-viewer/ddd-http/parse"
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

	card, err := parse.Card(data)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(card); err != nil {
		http.Error(w, "nelze zapsat JSON", http.StatusInternalServerError)
	}
}
