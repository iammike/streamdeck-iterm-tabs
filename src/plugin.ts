import streamDeck from "@elgato/streamdeck";
import { ITermTabAction } from "./actions/iterm-tab";

streamDeck.logger.setLevel("debug");

streamDeck.actions.registerAction(new ITermTabAction());

streamDeck.connect();
