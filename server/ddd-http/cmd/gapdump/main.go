package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"tacho-viewer/ddd-http/parse"
)

func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	card, err := parse.Card(data)
	if err != nil {
		panic(err)
	}
	raw, _ := json.Marshal(card)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	from := time.Date(2026, 6, 6, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 6, 14, 0, 0, 0, 0, time.UTC)
	for _, key := range []string{"card_driver_activity_2", "card_driver_activity_1"} {
		block, _ := doc[key].(map[string]any)
		if block == nil {
			continue
		}
		days, _ := block["decoded_activity_daily_records"].([]any)
		fmt.Printf("== %s days=%d\n", key, len(days))
		for _, day := range days {
			rec, _ := day.(map[string]any)
			stamp, _ := time.Parse(time.RFC3339, fmt.Sprint(rec["activity_record_date"]))
			if stamp.Before(from) || !stamp.Before(to) {
				continue
			}
			changes, _ := rec["activity_change_info"].([]any)
			fmt.Printf("%s changes=%d\n", stamp.Format("2006-01-02"), len(changes))
			for _, change := range changes {
				c, _ := change.(map[string]any)
				fmt.Printf("  min=%v driver=%v team=%v card=%v work=%v\n", c["minutes"], c["driver"], c["team"], c["card_present"], c["work_type"])
			}
		}
	}
	places, _ := doc["card_place_daily_work_period_2"].(map[string]any)
	records, _ := places["place_records"].([]any)
	fmt.Println("== places")
	for _, item := range records {
		rec, _ := item.(map[string]any)
		stamp, err := time.Parse(time.RFC3339, fmt.Sprint(rec["entry_time"]))
		if err != nil || stamp.Before(from) || !stamp.Before(to) {
			continue
		}
		fmt.Printf("  %s type=%v country=%v\n", stamp.Format(time.RFC3339), rec["entry_type_daily_work_period"], rec["daily_work_period_country"])
	}
}
