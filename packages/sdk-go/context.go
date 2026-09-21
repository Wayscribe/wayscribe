package wayscribe

import "context"

type journeyContextKey struct{}

// WithJourney preserves ctx's cancellation and deadline. Values are never
// copied automatically to recorded events. A nil context uses Background.
func WithJourney(ctx context.Context, j *Journey) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, journeyContextKey{}, j)
}
func JourneyFromContext(ctx context.Context) (*Journey, bool) {
	if ctx == nil {
		return nil, false
	}
	j, ok := ctx.Value(journeyContextKey{}).(*Journey)
	return j, ok && j != nil
}
