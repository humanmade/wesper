<?php
/**
 * Plugin Name: Wesper contract fixture
 * Description: Public, synthetic registry evidence used only by integration tests.
 * Version: 1.0.0
 */

defined( 'ABSPATH' ) || exit;

// The disposable site deliberately uses loopback HTTP. Make Application
// Password availability explicit so the permitted REST observation below does
// not depend on whether a particular core version treats localhost as SSL.
add_filter( 'wp_is_application_passwords_available', '__return_true' );

function wesper_contract_binding_value( $source_args, $block_instance, $attribute_name ) {
	return null;
}

add_action( 'init', static function (): void {
	// Global registrations deliberately follow subtype registrations below. The
	// collector must mirror core's global-over-subtype lookup precedence.
	register_post_meta( 'post', 'wesper_subtype_meta', array(
		'type' => 'integer', 'single' => true, 'show_in_rest' => true,
	) );
	register_post_meta( 'post', 'wesper_token_collision', array(
		'type' => 'integer', 'single' => true, 'show_in_rest' => true,
	) );
	register_post_meta( '', 'wesper_global_meta', array(
		'type' => 'string', 'single' => true, 'show_in_rest' => true,
	) );
	register_post_meta( '', 'wesper_token_collision', array(
		// The core post-meta binding resolver merges this global registration
		// after the subtype registration. Keeping it out of REST makes its
		// effective precedence observable through the actual resolver.
		'type' => 'string', 'single' => true, 'show_in_rest' => false,
	) );
	register_post_meta( 'post', 'wesper_filtered_meta', array(
		'type' => 'string', 'single' => true, 'show_in_rest' => true,
	) );

	if ( function_exists( 'register_block_bindings_source' ) ) {
		register_block_bindings_source( 'wesper/contract-source', array(
			'label'              => 'Wesper contract source',
			'uses_context'       => array( 'postId', 'postType' ),
			'get_value_callback' => 'wesper_contract_binding_value',
		) );
	}

	if ( function_exists( 'register_block_pattern' ) ) {
		register_block_pattern( 'wesper-contract/registered-pattern', array(
			'title'       => 'Wesper registered pattern',
			'categories'  => array( 'text' ),
			'blockTypes'  => array( 'core/post-content' ),
			'postTypes'   => array( 'post' ),
			'content'     => '<!-- wp:paragraph --><p>Fixture only</p><!-- /wp:paragraph -->',
		) );
	}
} );

// This filter is intentionally the authority for protected-meta behaviour;
// underscore-prefix heuristics alone are not an equivalent WordPress check.
add_filter( 'is_protected_meta', static function ( bool $protected, string $meta_key, string $meta_type ): bool {
	return $meta_type === 'post' && $meta_key === 'wesper_filtered_meta' ? true : $protected;
}, 10, 3 );

// The REST patterns controller can otherwise add remote catalog entries and
// populate their transients. This fixture tests only its local synthetic data.
add_filter( 'should_load_remote_block_patterns', '__return_false' );

// These filters exercise the actual resolver's theme and user layers without
// persisting private content. Schema version 2 is supported at the 6.5
// boundary and remains valid on the current WordPress line.
add_filter( 'wp_theme_json_data_theme', static function ( $theme_json ) {
	return $theme_json->update_with( array(
		'version' => 2,
		'settings' => array(
			'color' => array( 'palette' => array(
				array( 'slug' => 'wesper-theme-only', 'name' => 'Theme only', 'color' => '#113355' ),
				array( 'slug' => 'wesper-shared', 'name' => 'Theme shared', 'color' => '#112233' ),
			) ),
			'typography' => array( 'fontSizes' => array(
				array( 'slug' => 'wesper-shared', 'name' => 'Theme shared size', 'size' => '18px' ),
			) ),
		),
	) );
} );

add_filter( 'wp_theme_json_data_user', static function ( $theme_json ) {
	return $theme_json->update_with( array(
		'version' => 2,
		'settings' => array(
			'color' => array( 'palette' => array(
				array( 'slug' => 'wesper-user-only', 'name' => 'User only', 'color' => '#336699' ),
				array( 'slug' => 'wesper-shared', 'name' => 'User shared', 'color' => '#224466' ),
			) ),
			'typography' => array( 'fontSizes' => array(
				array( 'slug' => 'wesper-shared', 'name' => 'User shared size', 'size' => '20px' ),
			) ),
		),
	) );
} );
