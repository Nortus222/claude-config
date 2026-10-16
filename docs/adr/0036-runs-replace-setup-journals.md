# Runs replace setup journals

The old Setup journals required separate recovery state and helpers to resolve interrupted writes. Runs are the only durable progress record: interrupted runs retain their committed and remaining keys, backups and step evidence, and the user can re-preview from current reality or abandon the run while keeping existing changes. Interrupted runs never block new applies or app updates, and updates preserve their receipts. Backup-first writes and re-observation are enough for a single-user machine, so a second journal and recovery protocol add no needed authority.
