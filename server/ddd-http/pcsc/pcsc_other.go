//go:build !windows

package pcsc

import "fmt"

type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func Open() error {
	return &Error{Code: "unsupported", Message: "Čtení přes ovladač Windows je jen na Windows."}
}

func Transmit([]byte) ([]byte, error) {
	return nil, fmt.Errorf("pcsc není na této platformě")
}

func Close() {}
