#!/bin/sh
# Starts a disposable site, provisions only public synthetic registry data, and
# runs the Node contract. Nothing in the collector is permitted to write.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
compose="$root/integration/wordpress/compose.yml"
version_tag=$(printf '%s' "${WORDPRESS_VERSION:-6_5_6}" | tr '.' '_')
project="wesper-contract-${version_tag}-$$"
port="${WESPER_WORDPRESS_PORT:-18080}"
cleanup() { docker compose -p "$project" -f "$compose" down --volumes --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

docker compose -p "$project" -f "$compose" up -d --wait
for attempt in $(seq 1 45); do
  if curl -fsS "http://127.0.0.1:$port/wp-admin/install.php" >/dev/null; then break; fi
  [ "$attempt" -eq 45 ] && { echo "WordPress did not become ready" >&2; exit 1; }
  sleep 1
done

wp() { docker compose -p "$project" -f "$compose" exec -T wpcli wp --path=/var/www/html "$@"; }
wp core install --url="http://127.0.0.1:$port" --title='Wesper contract fixture' --admin_user=wesper --admin_password=wesper-fixture-password --admin_email=wesper@example.test --skip-email
# Docker creates mounts before WordPress initializes its named volume, so copy
# the read-only fixture into the disposable plugin directory during setup.
wp eval "wp_mkdir_p( WP_PLUGIN_DIR . '/wesper-contract' ); copy( '/fixtures/wesper-contract.php', WP_PLUGIN_DIR . '/wesper-contract/wesper-contract.php' );"
wp plugin activate wesper-contract
# Application passwords are generated per disposable run and passed only in
# process memory to the test. They are never committed or printed.
app_password=$(wp user application-password create wesper wesper-contract --porcelain)
# The fixture enables application passwords explicitly. Prove that core accepts
# this generated credential before the collector's permitted REST requests.
curl -fsS -u "wesper:$app_password" "http://127.0.0.1:$port/wp-json/wp/v2/users/me?context=edit" >/dev/null
wp_version=$(wp core version)
case "$wp_version" in
  "${WORDPRESS_VERSION:-6.5.6}"*) ;;
  *) echo "Provisioned WordPress $wp_version does not match ${WORDPRESS_VERSION:-6.5.6}" >&2; exit 1 ;;
esac
wp eval "if (!function_exists('get_all_registered_block_bindings_sources')) { fwrite(STDERR, 'Block Bindings API is unavailable' . PHP_EOL); exit(1); }"

# Capture only the synthetic content/meta values and registrations that the
# collector is forbidden to alter. Provisioning has finished before this point.
post_id=$(wp post create --post_title='Wesper fixture' --post_content='<!-- wp:paragraph --><p>Fixture content</p><!-- /wp:paragraph -->' --post_status=publish --porcelain)
wp post meta update "$post_id" wesper_global_meta fixture-global >/dev/null
wp post meta update "$post_id" wesper_subtype_meta 42 >/dev/null
wp post meta update "$post_id" wesper_token_collision fixture-collision >/dev/null
snapshot() {
  wp eval "\$post_id = (int) '$post_id'; \$subtype = get_registered_meta_keys('post', 'post'); \$global = get_registered_meta_keys('post', ''); \$bindings = get_all_registered_block_bindings_sources(); ksort(\$subtype); ksort(\$global); ksort(\$bindings); echo wp_json_encode(array('content' => get_post_field('post_content', \$post_id), 'meta' => get_post_meta(\$post_id), 'subtypeMeta' => \$subtype, 'globalMeta' => \$global, 'bindingSources' => array_keys(\$bindings)));"
}
before_collection=$(snapshot)
WESPER_COMPOSE_PROJECT="$project" \
WESPER_TEST_URL="http://127.0.0.1:$port" \
WESPER_TEST_USER=wesper \
WESPER_TEST_APP_PASSWORD="$app_password" \
npx tsx "$root/integration/wordpress/real-wordpress.test.ts"
after_collection=$(snapshot)
[ "$before_collection" = "$after_collection" ] || { echo 'Collector changed synthetic content, meta, or registrations' >&2; exit 1; }
