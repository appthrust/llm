package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

func warmup(model string) func(context.Context, *http.Client, string) error {
	body, _ := json.Marshal(map[string]any{
		"model": model, "stream": false, "max_tokens": 1,
		"messages": []map[string]string{{"role": "user", "content": "Reply OK."}},
	})
	return func(ctx context.Context, client *http.Client, upstream string) error {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, upstream+"/v1/chat/completions", bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("chat warm-up returned HTTP %d", resp.StatusCode)
		}
		var result struct {
			Choices []struct {
				Message struct {
					Role string `json:"role"`
				} `json:"message"`
			} `json:"choices"`
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&result); err != nil {
			return err
		}
		if len(result.Choices) != 1 || result.Choices[0].Message.Role != "assistant" {
			return errors.New("chat warm-up must return one assistant completion")
		}
		return nil
	}
}
