#!/bin/sh

if [ ! -f "ezmqtt-config.yaml" ]; then
	cp ezmqtt-config.yaml-dist ezmqtt-config.yaml
fi
exit 0
