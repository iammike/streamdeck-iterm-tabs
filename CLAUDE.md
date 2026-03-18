# streamdeck-iterm-tabs

## Logs

Plugin logs (use for debugging attention/notification issues):
```
~/Library/Application Support/com.elgato.StreamDeck/Plugins/com.iammikec.iterm-tabs.sdPlugin/logs/com.iammikec.iterm-tabs.0.log
```

Stream Deck app logs (startup, plugin connect/disconnect):
```
~/Library/Logs/ElgatoStreamDeck/StreamDeck.log
```

## Deploying changes

Editing source files is not enough. Build and restart with:
```bash
npm run build && pkill -x "Stream Deck" && sleep 2 && open -a "Elgato Stream Deck"
```
