# eNail Print Agent

Desktop application (Electron + TypeScript) for connecting eNail POS with hardware devices:

| Device | Model | Notes |
|--------|-------|-------|
| **Thermal Printer** | Posnet Thermal (HS FV, HD, XL) | POSNET or THERMAL protocol |
| **Barcode Scanner** | Standard HID | Keyboard wedge mode |
| **Cash Drawer** | Via Posnet printer | Future - triggered via print command |

## Requirements

- Windows 10/11 (64-bit)
- Node.js 18+
- npm or yarn

## Development Setup

```bash
# Install dependencies
npm install

# Rebuild native modules for Electron
npm run postinstall

# Start development mode
npm run dev

# Build for production
npm run build

# Create Windows installer
npm run dist:win
```

## Project Structure

```
print-agent/
├── src/
│   ├── main/           # Electron main process
│   │   ├── index.ts    # Entry point
│   │   ├── app.ts      # App lifecycle
│   │   ├── tray.ts     # System tray
│   │   ├── config/     # Configuration store
│   │   ├── network/    # Socket.IO client
│   │   ├── hardware/   # Device drivers
│   │   │   ├── posnet/ # Posnet printer driver
│   │   │   └── scanner/# Barcode scanner
│   │   └── updater.ts  # Auto-update
│   ├── renderer/       # React UI
│   │   ├── App.tsx
│   │   └── components/
│   ├── preload/        # Electron preload script
│   └── shared/         # Shared types
├── assets/
│   └── icons/          # App icons
└── release/            # Build output
```

## Pairing Flow

1. Download and install the agent
2. Agent generates machine ID automatically
3. Open eNail Dashboard → Settings → Print Agent
4. Enter the 6-digit pairing code displayed in the agent
5. Agent connects automatically when paired

## Configuration

Configuration is stored in:
- Windows: `%APPDATA%/enail-print-agent/config.json`

### Supported Printers

- Posnet Thermal HS FV
- Posnet Thermal HD
- Posnet Thermal XL
- Other Posnet-compatible fiscal printers

### Protocol Reference

- [Posnet THERMAL Protocol](https://www.soft-bit.pl/downloads/all/Posnet/pliki/THS-I-DEV-02-006_specyfikacja_protokolu_Thermal_w_Thermal_HS_FV.pdf)
- [Posnet POSNET Protocol](https://4programmers.net/assets/20277/DBC-I-DEV-45-021_specyfikacja_protokolu_Posnet_w_drukarkach.pdf)

## License

MIT
