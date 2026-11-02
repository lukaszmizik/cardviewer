//go:build windows

package pcsc

import (
	"fmt"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

var (
	winscard       = syscall.NewLazyDLL("winscard.dll")
	procEstablish  = winscard.NewProc("SCardEstablishContext")
	procRelease    = winscard.NewProc("SCardReleaseContext")
	procList       = winscard.NewProc("SCardListReadersW")
	procConnect    = winscard.NewProc("SCardConnectW")
	procDisconnect = winscard.NewProc("SCardDisconnect")
	procTransmit   = winscard.NewProc("SCardTransmit")
)

const (
	scopeUser          = 0
	shareShared        = 2
	protocolT0         = 1
	protocolT1         = 2
	leaveCard          = 0
	errNoReaders       = 0x8010002E
	errNoSmartCard     = 0x8010000C
	errSharing         = 0x8010000B
	errRemoved         = 0x80100069
	errUnresponsive    = 0x80100066
	errUnavailable     = 0x80100017
)

type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

type ioRequest struct {
	Protocol  uint32
	PciLength uint32
}

type session struct {
	context  uintptr
	card     uintptr
	protocol uint32
}

var (
	mu      sync.Mutex
	current *session
)

func Open() error {
	mu.Lock()
	defer mu.Unlock()
	closeLocked()

	var ctx uintptr
	if status := call(procEstablish, uintptr(scopeUser), 0, 0, uintptr(unsafe.Pointer(&ctx))); status != 0 {
		return fmt.Errorf("SCardEstablishContext 0x%X", status)
	}

	readers, err := listReaders(ctx)
	if err != nil {
		_, _, _ = procRelease.Call(ctx)
		return err
	}
	if len(readers) == 0 {
		_, _, _ = procRelease.Call(ctx)
		return &Error{Code: "no_reader", Message: "Windows nenašel žádnou čtečku. Zkontrolujte kabel a ovladač Thales."}
	}

	reader := pickReader(readers)
	name, err := syscall.UTF16PtrFromString(reader)
	if err != nil {
		_, _, _ = procRelease.Call(ctx)
		return err
	}
	var card uintptr
	var protocol uint32
	status := call(procConnect,
		ctx,
		uintptr(unsafe.Pointer(name)),
		uintptr(shareShared),
		uintptr(protocolT0|protocolT1),
		uintptr(unsafe.Pointer(&card)),
		uintptr(unsafe.Pointer(&protocol)),
	)
	if status != 0 {
		_, _, _ = procRelease.Call(ctx)
		return connectError(status)
	}
	current = &session{context: ctx, card: card, protocol: protocol}
	return nil
}

func Transmit(apdu []byte) ([]byte, error) {
	mu.Lock()
	defer mu.Unlock()
	if current == nil {
		return nil, &Error{Code: "open", Message: "Čtečka není připojená."}
	}
	if len(apdu) == 0 {
		return nil, fmt.Errorf("prázdný APDU")
	}
	pci := ioRequest{Protocol: current.protocol, PciLength: uint32(unsafe.Sizeof(ioRequest{}))}
	recv := make([]byte, 65536)
	recvLen := uint32(len(recv))
	status := call(procTransmit,
		current.card,
		uintptr(unsafe.Pointer(&pci)),
		uintptr(unsafe.Pointer(&apdu[0])),
		uintptr(len(apdu)),
		0,
		uintptr(unsafe.Pointer(&recv[0])),
		uintptr(unsafe.Pointer(&recvLen)),
	)
	if status != 0 {
		return nil, transmitError(status)
	}
	if recvLen > uint32(len(recv)) {
		recvLen = uint32(len(recv))
	}
	out := make([]byte, recvLen)
	copy(out, recv[:recvLen])
	return out, nil
}

func Close() {
	mu.Lock()
	defer mu.Unlock()
	closeLocked()
}

func closeLocked() {
	if current == nil {
		return
	}
	if current.card != 0 {
		_, _, _ = procDisconnect.Call(current.card, uintptr(leaveCard))
	}
	if current.context != 0 {
		_, _, _ = procRelease.Call(current.context)
	}
	current = nil
}

func call(proc *syscall.LazyProc, args ...uintptr) uintptr {
	r, _, _ := proc.Call(args...)
	return r
}

func listReaders(ctx uintptr) ([]string, error) {
	var count uint32
	status := call(procList, ctx, 0, 0, uintptr(unsafe.Pointer(&count)))
	if status == errNoReaders || count == 0 {
		return nil, nil
	}
	if status != 0 {
		return nil, fmt.Errorf("SCardListReaders 0x%X", status)
	}
	buf := make([]uint16, count)
	status = call(procList, ctx, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&count)))
	if status != 0 {
		return nil, fmt.Errorf("SCardListReaders 0x%X", status)
	}
	var readers []string
	start := 0
	for i, ch := range buf {
		if ch != 0 {
			continue
		}
		if i > start {
			readers = append(readers, syscall.UTF16ToString(buf[start:i+1]))
		}
		start = i + 1
	}
	return readers, nil
}

func pickReader(readers []string) string {
	for _, name := range readers {
		upper := strings.ToUpper(name)
		if strings.Contains(upper, "THALES") || strings.Contains(upper, "GEMALTO") || strings.Contains(upper, "SMART") {
			return name
		}
	}
	return readers[0]
}

func connectError(status uintptr) error {
	switch status {
	case errNoSmartCard, errRemoved, errUnresponsive:
		return &Error{Code: "no_card", Message: "Ve čtečce není karta. Vložte kartu řidiče čipem napřed a čtení spusťte až potom."}
	case errSharing, errUnavailable:
		return &Error{Code: "blocked", Message: "Čtečku právě používá jiný program (často Datacho). Ukončete ho a zkuste to znovu."}
	default:
		return &Error{Code: "open", Message: fmt.Sprintf("Windows čtečku nepřipojil (0x%X).", status)}
	}
}

func transmitError(status uintptr) error {
	switch status {
	case errRemoved, errNoSmartCard, errUnresponsive:
		return &Error{Code: "no_card", Message: "Karta během čtení zmizela. Nechte ji ve čtečce až do konce."}
	case errSharing, errUnavailable:
		return &Error{Code: "blocked", Message: "Čtečku právě používá jiný program (často Datacho). Ukončete ho a zkuste to znovu."}
	default:
		return fmt.Errorf("SCardTransmit 0x%X", status)
	}
}
