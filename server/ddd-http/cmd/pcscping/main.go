package main

import (
	"fmt"
	"os"

	"tacho-viewer/ddd-http/pcsc"
)

func main() {
	if err := pcsc.Open(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer pcsc.Close()
	// SELECT tachograph AID gen2, pak gen1. Stačí vědět, že karta odpovídá.
	aids := [][]byte{
		{0x00, 0xA4, 0x04, 0x0C, 0x06, 0xFF, 0x53, 0x4D, 0x52, 0x44, 0x54},
		{0x00, 0xA4, 0x04, 0x0C, 0x06, 0xFF, 0x54, 0x41, 0x43, 0x48, 0x4F},
	}
	for _, apdu := range aids {
		resp, err := pcsc.Transmit(apdu)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Printf("odpověď % X\n", resp)
	}
}
