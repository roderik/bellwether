#!/usr/bin/env node

const { cli } = await import("./cli.js");
void cli.serve();
