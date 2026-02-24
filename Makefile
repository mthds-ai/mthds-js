.DEFAULT_GOAL := help
.PHONY: help install check c test t clean build rebuild run dev pack

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

help:
	@echo "$(BLUE)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(NC)"
	@echo "$(BLUE)                    mthds — Development Tools$(NC)"
	@echo "$(BLUE)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(NC)"
	@echo ""
	@echo "$(YELLOW)Quick Start:$(NC)"
	@echo "  $(GREEN)make install$(NC)        Install dependencies"
	@echo "  $(GREEN)make check$(NC)          Run quality checks (typecheck + tests)"
	@echo "  $(GREEN)make test$(NC)           Run the test suite"
	@echo "  $(GREEN)make dev$(NC)            Watch mode — auto rebuild on changes"
	@echo ""
	@echo "$(YELLOW)Development:$(NC)"
	@echo "  $(GREEN)make build$(NC)          Build the project"
	@echo "  $(GREEN)make rebuild$(NC)        Clean and rebuild"
	@echo "  $(GREEN)make clean$(NC)          Remove build artifacts"
	@echo "  $(GREEN)make run$(NC)            Build and run the CLI (banner)"
	@echo ""
	@echo "$(YELLOW)Shorthands:$(NC)"
	@echo "  $(GREEN)make c$(NC)              Alias for check"
	@echo "  $(GREEN)make t$(NC)              Alias for test"
	@echo ""
	@echo "$(YELLOW)Packaging:$(NC)"
	@echo "  $(GREEN)make pack$(NC)           Create tarball for local npx testing"
	@echo ""
	@echo "$(BLUE)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(NC)"
	@echo "$(YELLOW)Tip:$(NC) Run $(GREEN)make <command>$(NC) to execute any command above"
	@echo "$(BLUE)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(NC)"

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

check: build test
	@echo "$(GREEN)✓ All checks passed$(NC)"

clean:
	$(call PRINT_TITLE,"Cleaning Build Artifacts")
	@rm -rf dist/
	@rm -rf *.tsbuildinfo
	@echo "$(GREEN)✓ Clean complete$(NC)"

rebuild: clean build

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
