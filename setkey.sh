#!/bin/zsh
K=$(pbpaste | tr -d "[:space:]")
[[ $K == sk-ant-* ]] || { echo "clipboard has no key"; exit 1; }
sed -i "" "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$K|" .env
echo "saved, ${#K} chars"
