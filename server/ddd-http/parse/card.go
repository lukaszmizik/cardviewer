package parse

import (
	"fmt"

	"github.com/traconiq/tachoparser/pkg/decoder"
)

func Card(data []byte) (*decoder.Card, error) {
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
