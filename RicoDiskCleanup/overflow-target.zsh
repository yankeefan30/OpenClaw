# Overflow target for RicoDiskCleanup.
#
# Polar / Alan: when a USB4 or Thunderbolt SSD is attached for overflow,
# change ONLY the values below. Do not rewrite the playbook, do not move
# Littlebird / Hedy / LM Studio / llmster / apps / working trees, and do
# not put Time Machine on the overflow volume.
#
# Current device (2026-08-25): 4TB G-DRIVE, HFS volume "Movie Drive",
# HGST HDS724040ALE640 spinning SATA behind Thunderbolt. Fine for sequential
# overflow (old installers, one-shot archives, cold copies). Bad for random I/O
# and a bad Time Machine target (HFS + mixed movie library).

typeset RICO_OVERFLOW_VOLUME="/Volumes/Movie Drive"
typeset RICO_OVERFLOW_VOLUME_NAME="Movie Drive"
typeset RICO_OVERFLOW_ROOT_NAME="Rico-Overflow"
# hdd-sequential today. Set to ssd-random when the path above points at the SSD.
# Policy does not change with class — only the mount path does.
typeset RICO_OVERFLOW_DEVICE_CLASS="hdd-sequential"
