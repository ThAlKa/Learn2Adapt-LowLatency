#!/bin/bash

SERVER="${1}"
PORT="${2}"
FF="${3}"
#TLS_KEY="/home/borgmann/dash/certs/ingest_client_thilo.key"
#TLS_CRT="/home/borgmann/dash/certs/ingest_client_thilo.crt"
#TLS_CA="/home/borgmann/dash/certs/ca.crt"
#TS_OUT="/home/borgmann/dash/ts"
INPUT="/dev/video0"
INPUT_FPS="10"
ID=live
ACODEC=aac
VCODEC=h264_vaapi
VCODEC=libx264
COLOR=bt709
TARGET_LATENCY="3.5"

if [ "$SERVER" == "" -o "$PORT" == "" ]
then
    echo "Usage: $0 <SERVER> <PORT> [<FFMPEG>]"
    exit
else
    if [ "$FF" == "" ]
    then
        FF=ffmpeg
    fi

    PROTO=http
    HTTP_OPTS=""

    echo "Ingesting to: ${PROTO}://${SERVER}:${PORT}/${ID}/${ID}.mpd"
fi

echo ${FF} -h all | grep ldash

PROFILE_FAST="-b:v:0 100K -s:v:0 640x360 -b:v:1 300K -s:v:1 852x480 -map 0:v:0 -map 0:v:0 -adaptation_sets id=0,seg_duration=0.5,streams=0,1"
PROFILE_NORMAL="-b:v:0 200K -s:v:0 640x360 -b:v:1 600K -s:v:1 852x480 -b:v:2 1000K -s:v:2 1280x720 -map 0:v:0 -map 0:v:0 -map 0:v:0 -adaptation_sets id=0,seg_duration=0.5,streams=0,1,2"

LADDER_PROFILE=""
if [ "$PROFILE" == "PROFILE_FAST" ]
then
    LADDER_PROFILE=$PROFILE_FAST
    echo "Using fast ffmpeg profile (360p@100K, 480p@300K)"
else
    LADDER_PROFILE=$PROFILE_NORMAL
    echo "Using normal ffmpeg profile (360p@200K, 480p@600K, 720p@1000K)"
fi

${FF} -hide_banner -loglevel panic \
-re -i bbb.mp4 \
-c:v ${VCODEC} -b:v:0 500K -b:v:1 200K -s:v:0 960x400 -s:v:1 720x300 \
-map 0:v:0 -map 0:v:0 \
-c:a ${ACODEC} -b:a 96K -ac 2 \
-map 1:a:0 \
-use_timeline 0 \
-mpd_profile dvb_dash \
-utc_timing_url "http://time.akamai.com" \
-format_options "movflags=cmaf" \
-frag_type duration \
-g:v 20 -keyint_min:v 20 -sc_threshold:v 0 -streaming 1 -ldash 1 -tune zerolatency \
-export_side_data prft \
-write_prft 1 \
-target_latency ${TARGET_LATENCY} \
-color_primaries ${COLOR} -color_trc ${COLOR} -colorspace ${COLOR} \
-f dash \
${HTTP_OPTS} \
${PROTO}://${SERVER}:${PORT}/${ID}/${ID}.mpd \
${TS_OUT_CMD}
