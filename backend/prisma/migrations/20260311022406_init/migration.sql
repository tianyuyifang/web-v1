-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "songs" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "duration" INTEGER,
    "file_path" TEXT NOT NULL,
    "lyrics" TEXT,
    "starts" TEXT,
    "title_pinyin" TEXT,
    "title_pinyin_initials" TEXT,
    "artist_pinyin" TEXT,
    "artist_pinyin_initials" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "songs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "song_artists" (
    "id" UUID NOT NULL,
    "song_id" UUID NOT NULL,
    "artist_name" TEXT NOT NULL,
    "artist_pinyin" TEXT,
    "artist_pinyin_initials" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "song_artists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clips" (
    "id" UUID NOT NULL,
    "song_id" UUID NOT NULL,
    "start" INTEGER NOT NULL,
    "length" INTEGER NOT NULL DEFAULT 25,
    "lyrics" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playlists" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "name_pinyin" TEXT,
    "name_pinyin_initials" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "playlists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playlist_shares" (
    "id" UUID NOT NULL,
    "playlist_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playlist_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playlist_copy_permissions" (
    "id" UUID NOT NULL,
    "playlist_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playlist_copy_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playlist_clips" (
    "id" UUID NOT NULL,
    "playlist_id" UUID NOT NULL,
    "clip_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "speed" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "pitch" INTEGER NOT NULL DEFAULT 0,
    "color_tag" TEXT,
    "comment" TEXT,
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playlist_clips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "likes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "playlist_id" UUID NOT NULL,
    "clip_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "likes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "clips_song_id_start_key" ON "clips"("song_id", "start");

-- CreateIndex
CREATE UNIQUE INDEX "playlist_shares_playlist_id_user_id_key" ON "playlist_shares"("playlist_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "playlist_copy_permissions_playlist_id_user_id_key" ON "playlist_copy_permissions"("playlist_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "playlist_clips_playlist_id_clip_id_key" ON "playlist_clips"("playlist_id", "clip_id");

-- CreateIndex
CREATE UNIQUE INDEX "likes_user_id_playlist_id_clip_id_key" ON "likes"("user_id", "playlist_id", "clip_id");

-- AddForeignKey
ALTER TABLE "song_artists" ADD CONSTRAINT "song_artists_song_id_fkey" FOREIGN KEY ("song_id") REFERENCES "songs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clips" ADD CONSTRAINT "clips_song_id_fkey" FOREIGN KEY ("song_id") REFERENCES "songs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_shares" ADD CONSTRAINT "playlist_shares_playlist_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_shares" ADD CONSTRAINT "playlist_shares_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_copy_permissions" ADD CONSTRAINT "playlist_copy_permissions_playlist_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_copy_permissions" ADD CONSTRAINT "playlist_copy_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_clips" ADD CONSTRAINT "playlist_clips_playlist_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_clips" ADD CONSTRAINT "playlist_clips_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "likes" ADD CONSTRAINT "likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "likes" ADD CONSTRAINT "likes_playlist_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "likes" ADD CONSTRAINT "likes_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
