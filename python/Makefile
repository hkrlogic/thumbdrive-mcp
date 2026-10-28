.PHONY: dev run test lint fmt
dev:   ## run with sample data in ./dev-data
	uv run thumbdrive --dev
run:
	uv run thumbdrive
test:
	uv run pytest -q
lint:
	uv run ruff check . && uv run ruff format --check .
fmt:
	uv run ruff check --fix . && uv run ruff format .
