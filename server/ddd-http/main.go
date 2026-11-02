package main

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"

	"tacho-viewer/ddd-http/parse"
	"tacho-viewer/ddd-http/pcsc"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /parse-card", handleParseCard)
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/pcsc/open", withCORS(handlePcscOpen))
	mux.HandleFunc("/pcsc/transmit", withCORS(handlePcscTransmit))
	mux.HandleFunc("/pcsc/close", withCORS(handlePcscClose))

	addr := "127.0.0.1:8787"
	log.Printf("dddparser HTTP naslouchá na http://%s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

func cors(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

func withCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

func writePcscError(w http.ResponseWriter, err error) {
	var pcscErr *pcsc.Error
	code := "open"
	message := err.Error()
	status := http.StatusBadGateway
	if errors.As(err, &pcscErr) {
		code = pcscErr.Code
		message = pcscErr.Message
		if code == "no_card" || code == "blocked" || code == "no_reader" {
			status = http.StatusConflict
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code, "message": message})
}

func handlePcscOpen(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	if err := pcsc.Open(); err != nil {
		log.Printf("PC/SC open: %v", err)
		writePcscError(w, err)
		return
	}
	log.Printf("PC/SC open: spojení se čtečkou navázáno")
	w.WriteHeader(http.StatusNoContent)
}

func handlePcscTransmit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	apdu, err := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	if err != nil || len(apdu) == 0 {
		http.Error(w, "prázdný APDU", http.StatusBadRequest)
		return
	}
	response, err := pcsc.Transmit(apdu)
	if err != nil {
		writePcscError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	_, _ = w.Write(response)
}

func handlePcscClose(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	pcsc.Close()
	log.Printf("PC/SC close: spojení uvolněno")
	w.WriteHeader(http.StatusNoContent)
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
