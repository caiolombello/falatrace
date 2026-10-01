SHELL := /bin/bash

APP_NAME := falatrace
INSTALL_PREFIX ?= $(HOME)/.local
BIN_DIR := $(INSTALL_PREFIX)/bin
DIST_DIR := dist
ENTRY := $(DIST_DIR)/index.js
STANDALONE_ENTRY := $(DIST_DIR)/$(APP_NAME)

.PHONY: help install-deps install-cli install uninstall build build-standalone

help:
	@echo "Targets:"
	@echo "  install-deps  Install system dependencies (Ubuntu)"
	@echo "  build         Build CLI into dist/"
	@echo "  build-standalone Build a standalone executable"
	@echo "  install-cli   Install CLI executable into $(BIN_DIR)"
	@echo "  install       install-cli (system dependencies are an explicit separate step)"
	@echo "  uninstall     Remove CLI executable"

install-deps:
	sudo apt-get update
	sudo apt-get install -y ffmpeg wf-recorder libglib2.0-bin gstreamer1.0-pipewire gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav python3-gi gir1.2-ayatanaappindicator3-0.1 gnome-shell-ubuntu-extensions

build:
	bun build src/cli/index.ts --target=bun --outdir $(DIST_DIR)

build-standalone:
	bun build --compile src/cli/index.ts --outfile $(STANDALONE_ENTRY)

install-cli: build-standalone
	mkdir -p "$(BIN_DIR)"
	install -m 755 "$(STANDALONE_ENTRY)" "$(BIN_DIR)/$(APP_NAME)"
	@echo "Installed $(APP_NAME) to $(BIN_DIR)/$(APP_NAME)"

install: install-cli

uninstall:
	rm -f "$(BIN_DIR)/$(APP_NAME)"
