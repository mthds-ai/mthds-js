.DEFAULT_GOAL := help
.PHONY: help install check c test t clean build rebuild run dev pack all depcruise

# Colors
BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[0;33m
RED := \033[0;31m
NC := \033[0m

PACKAGE_NAME := mthds

# Helper function to print titles
define PRINT_TITLE
	@echo "$(BLUE)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(NC)"
	@echo "$(BLUE)$(1)$(NC)"
	@echo "$(BLUE)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(NC)"
	@echo ""
endef

define HELP
Manage $(PACKAGE_NAME) located in $(CURDIR).
Usage:

make install    - Install dependencies
make all        - Clean, check, and test
make check      - Run quality checks, excluding tests
make test       - Run the test suite
make dev        - Watch mode: auto rebuild on changes

make build      - Build the project
make rebuild    - Clean and rebuild
make clean      - Remove build artifacts
make run        - Build and run the CLI banner
make depcruise  - Check architectural boundaries

make pack       - Create tarball for local npx testing

make c          - Shorthand -> check
make t          - Shorthand -> test

endef
export HELP

help:
	@echo "$$HELP"

install:
	$(call PRINT_TITLE,"Installing Dependencies")
	@npm install
	@echo "$(GREEN)✓ Installation complete$(NC)"

build:
	$(call PRINT_TITLE,"Building Project")
	@npm run build
	@echo "$(GREEN)✓ Build complete$(NC)"

test:
	$(call PRINT_TITLE,"Running Tests")
	@npx vitest run
	@echo "$(GREEN)✓ All tests passed$(NC)"

depcruise:
	$(call PRINT_TITLE,"Checking Architectural Boundaries")
	@npm run depcruise
	@echo "$(GREEN)✓ protocol/ boundary intact$(NC)"

check:
	@npm run check
	@echo "$(GREEN)✓ All checks passed$(NC)"

clean:
	$(call PRINT_TITLE,"Cleaning Build Artifacts")
	@rm -rf dist/
	@rm -rf *.tsbuildinfo
	@echo "$(GREEN)✓ Clean complete$(NC)"

rebuild: clean build

all: clean check test
	@echo "$(GREEN)✓ All complete$(NC)"

run: rebuild
	@node dist/cli.js

dev:
	$(call PRINT_TITLE,"Watching for Changes")
	@npx tsc --watch

pack: rebuild
	$(call PRINT_TITLE,"Creating Tarball")
	@npm pack
	@echo ""
	@echo "$(GREEN)✓ Tarball created$(NC)"
	@echo "$(YELLOW)Test with: npx ./$(PACKAGE_NAME)-$$(node -p \"require('./package.json').version\").tgz$(NC)"

# Shorthands
c: check
t: test
